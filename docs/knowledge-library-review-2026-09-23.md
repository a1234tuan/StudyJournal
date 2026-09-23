# 知识库（Knowledge Library）提交审查报告

- **审查日期**：2026-09-23
- **审查方式**：纯静态源码审查（只读）。**未执行** `build` / `npm test` / `npx tsc` / Playwright，以避免产生构建与测试产物污染工作区。
- **审查范围**：从知识库首次落地到后续优化的 5 个提交

| 提交 | 说明 | 规模 |
|---|---|---|
| `35b62f0` | feat: add knowledge library v1 | 71 files, +5904 / −156 |
| `b4af1f4` | fix: repair voice recall and review coach audit findings | 13 files, +397 / −77 |
| `b19af74` | fix: harden knowledge library cloud validation | 10 files, +292 / −82 |
| `54c821a` | fix(knowledge-library): simplify workspace UX and unify sync controls | 28 files, +1594 / −259 |
| `c9f4b68` | feat(knowledge-library): refine mind map layout and node interactions | 13 files, +720 / −170 |

- **审查对象**：`src/features/knowledgeLibrary/` 全模块（24 个生产文件 + 12 个单测文件）、`firestore.rules`、4 个 e2e spec、`src/App.tsx` 中知识库接线、`src/services/storageAdapter.ts` 知识库还原路径、`src/lib/webNavigationHistory.ts`、相关文档与 `AGENTS.md`。
- **约束声明**：本次审查**未修改任何产品代码**，**未提交、未推送**，工作区仅新增本报告一个文件。

---

## 结论摘要

整体工程质量**明显高于一般业务迭代**：协议层具备命令幂等回执、因果版本链、合并版本 id 由父集合哈希确定性生成、组代次/`setToken` 单调递增、预算硬约束、`__proto__` 原型污染防护、`firestore.rules` 对 15 个槽位的逐项校验；测试覆盖面（12 个白盒套件 + 4 个 e2e spec + Firebase Emulator）与文档记录（每轮改动均附验收数据与限制说明）都相当扎实。

但存在 **3 项 P0 级问题**：一个可被远端数据触发的原型污染面、一处"本地伪造序号 + 伪造回执"会破坏端到端序号一致性、以及工程指导文档（`AGENTS.md`）的基线自相矛盾。另有 8 项 P1 与 8 项 P2。

| 级别 | 数量 | 主题 |
|---|---|---|
| **P0（必须修）** | 3 | 原型污染防护不一致；本地伪造序号/回执；`AGENTS.md` 基线矛盾 |
| **P1（建议修）** | 8 | 巨型单行 JSX；revisions 过滤基准错位；导入绕开 strict；全量 `structuredClone`；非空断言分布；`useMemo` 依赖缺失；搜索不传 assets；导出命名与实际内容不符 |
| **P2（以后修）** | 8 | 布局/查询复杂度；`mapSides` 上限与平台差异；原生 `confirm`；诊断信息无导出入口等 |

---

# P0 — 必须修

## P0-1 `restoreKnowledgeNavigation` 未排除原型污染键，与协议层防护不一致

**位置**：`src/features/knowledgeLibrary/navigation.ts:21`、`:23`

**现象**

`restoreKnowledgeNavigation` 的 `identifier()` 净化函数只做"是字符串且长度 ≤ 200"两个判断：

```ts
const identifier = (candidate: unknown): string | undefined =>
  typeof candidate === "string" && candidate.length <= 200 ? candidate : undefined;
```

`mapSides` 的键同样只过滤长度：

```ts
mapSides: value.mapSides && typeof value.mapSides === "object"
  ? Object.fromEntries(Object.entries(value.mapSides)
      .filter(([id, side]) => id.length <= 200 && (side === -1 || side === 1))
      .slice(0, 10000))
  : {}
```

因此 `__proto__` / `constructor` / `prototype` 均可通过净化。这五个字段（`libraryId`、`workspaceId`、`selectedNodeId`、`addRecordId`、`mapWorkspaceId`）是 `identifier()` 的产物，`mapSides` 的键是额外一个入口。

**影响**

`restoreKnowledgeNavigation` 的输入来自 `window.history.state`（经 `src/lib/webNavigationHistory.ts:287` 的 `createWebNavigationSnapshot` / `restoreWebNavigationSnapshot` 往返）。`history.state` 由同源页面通过 `pushState` 写入，正常路径下不可被远端污染；但：

1. 该函数是本模块**唯一**接受外部未校验结构的入口，语义上是"净化器"，其职责就应包含键白名单；
2. 本仓库其他三处同类净化（`protocol.ts:6-7` 的 `validId` / `validStoredId`、`cloudProtocol.ts` 的 `normalizeKnowledgeCloudSlot`、`backup.ts` 的 `validateKnowledgeEnvelope`）**均已显式排除这三个键**，唯独此处遗漏，形成防护不一致；
3. `mapSides` 后续被当作 `Record<string, number>` 读取（`KnowledgeMap.tsx` 的 `sides.current`），若键为 `__proto__`，`Object.fromEntries` 虽不直接改原型，但下游若做 `sides.current[id]` 形态的读取赋值则会落到原型链。

**建议**

将 `identifier()` 改为复用协议层的同一判据（或抽出共享的 `validRestoredId`），并要求 `mapSides` 的键同样通过该判据：

```ts
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const identifier = (candidate: unknown): string | undefined =>
  typeof candidate === "string" && candidate.length > 0 && candidate.length <= 200 && !RESERVED.has(candidate)
    ? candidate : undefined;
```

`mapSides` 过滤条件补 `&& !RESERVED.has(id)`。同时建议为该函数补一条"含 `__proto__` 键必须被丢弃"的断言，把它纳入既有 12 个单测套件的净化用例组。

---

## P0-2 `synchronize` 在本地无变化时伪造递增序号并写入伪造回执

**位置**：`src/features/knowledgeLibrary/sync.ts:154-158`

**现象**

当 `applyKnowledgeCommand(remote, entry.command)` 返回**同一个对象引用**（即该命令在本地投影上不产生任何变化）时，代码并不跳过发布，而是复制远端状态、人为把 `sequence` 加一、并写入一条回执：

```ts
let after = applyKnowledgeCommand(remote, entry.command);
if (after === remote) {
  after = structuredClone(remote);
  after.sequence += 1;
  after.receipts[entry.id] = { id: entry.id, hash: entry.hash, sequence: after.sequence };
}
const packet = knowledgeCloudPacket(remote, after, entry.command);
```

随后该 `packet` 被真正 `transport.publish` 到云端。

**影响**

1. **端到端序号被人为推进**：本地 `remote` 视图的 `sequence` 因此比云端真实 `head.sequence` 多 1。虽然紧接的 `await this.pull(context)` 会以云端为准纠正（`readKnowledgeRemote` 里 `state.sequence = cursor`），但在这两步之间的窗口内，任何以本地 `remote` 为基准的乐观判断都会偏差一格。
2. **伪造回执进入本地状态**：`after.receipts[entry.id]` 是一条"本地生成、云端并不存在"的回执。`applyKnowledgeCommand` 的幂等短路（`protocol.ts:254-258`）依赖回执来判定"命令已应用"。若该命令因**并发冲突**（如另一设备同时改了同一个 `unit`）在云端被拒，本地却已凭这条伪造回执认为自己成功，会导致本端与远端对"该命令是否生效"的认知分叉。
3. **与 `firestore.rules` 的序号约束耦合**：`firestore.rules` 的 `validHeadUpdate()` 强制 `sequence == resource.data.sequence + 1`，规则本身能拦住伪造，但拦下的结果是 `stale` 异常，走重试退避（3 次尝试后抛出），表现为"用户操作已保存、但同步迟迟不收敛而后报错"，而非清晰的冲突提示。
4. 测试佐证：`sync.test.ts` 中的 `MemoryKnowledgeCloud` 专门实现了 `loseNextResponse`，说明团队已意识到"响应丢失 → 本地状态与云端不一致"是真实场景；本处的伪造序号正好制造了同一类偏差，却是主动引入的。

**建议**

两种收敛方向，择一：

- **方案 A（推荐，最小改动）**：`after === remote` 时，若命令确无副作用，则**不发布**，直接走回执确认路径——即由服务端（或一次 `pull`）来确认该命令的 `commandId` 已被接受。可参照 `persistLedgers` 中"确认行不重复发布"的既有约定。
- **方案 B**：保留发布，但**不伪造 `sequence`**，`packet` 的序号必须来自云端真实 `head`；若云端尚未接受该命令，则应等到 `pull` 拉到对应 receipt 后再标记 `confirmed`。

无论哪种方案，**都必须在一条断言里禁止"本地生成 receipt"**——回执的产生权应唯一归属于云端接受路径。

---

## P0-3 `AGENTS.md` 基线自相矛盾，且未记录最近两次知识库提交

**位置**：`AGENTS.md:5` vs `AGENTS.md:41`

**现象**

同一份文件的两行直接冲突：

- 第 5 行："Planned schema25 now has eleven knowledge stores including local knowledgeBackupScopes; **actual schema remains24**."
- 第 41 行："Database version: **schema 25**. … schema 25 adds the eleven knowledge-library stores."

而源码事实是 `src/db/database.ts:368` 明确存在 `this.version(25).stores(KNOWLEDGE_SCHEMA_25_STORES);`——即**第 5 行的 "actual schema remains24" 是过期残留**，第 41 行才与代码一致。

同时，`grep` 检索 `AGENTS.md` 中 `map-refinement` / `ux-follow-up` 均为空，说明 **`54c821a`（UX 简化与同步控件统一）和 `c9f4b68`（导图布局与节点交互精细化）两次提交完全没有在 `AGENTS.md` 中留痕**。

**影响**

本仓库的既有约定（见工作区长期记忆与 `CONTRIBUTING.md`）是"改动落地 + `AGENTS.md` 记录 + `docs/` 详述"三件套，并明确 **`AGENTS.md` 是本仓库代码/产品事实的唯一权威**。因此：

1. **第 5 行的过期句会主动误导后续判断**——尤其本次审查本身就差点因它误判"schema 未升到 25"。任何以"读 `AGENTS.md`"为起点的后续工作（包括其他 AI 的接管、以及本仓库自身"以 `AGENTS.md` 引用判定活文档"的归档流程）都会被带偏。
2. 两次提交无记录，使得当前 `AGENTS.md` 描述的 UI/交互形态与代码实际形态脱节（例如 `54c821a` 移除了独立同步按钮、改由应用顶部统一处理；`c9f4b68` 引入长按 350ms / 单击 220ms 判别与 F2 重命名等交互），而 `AGENTS.md` 与 `CHANGELOG.md` 的 `Unreleased` 段落均未提及。

**建议**

1. 删除或改写第 5 行的 `actual schema remains24`，使其与第 41 行一致（保留"五个边界为文档先行、D12 的 21 个用例尚未执行"这类**仍然成立**的限定语）。
2. 在 `AGENTS.md` 的 Current Baseline 顶部补两段，分别覆盖 `54c821a` 与 `c9f4b68`，格式对齐既有条目（"做了什么 + 验收数据 + 未做/边界"）。
3. 在 `CHANGELOG.md` 的 `Unreleased` 下补知识库相关条目，避免发布时漏记。
4. 建议在 CI 或提交钩子里加一条"改了 `src/features/knowledgeLibrary/**` 或 `src/db/database.ts` 却未改 `AGENTS.md` 则告警"的轻量检查——本仓库已有 `scripts/` 目录可承载。

> 说明：本报告只审查**已提交的历史改动**。上述 `AGENTS.md` 修正属于"文档欠账"，不涉及产品行为，但因其是事实权威，定级 P0。

---

# P1 — 建议修

## P1-1 `KnowledgeLibraryPage.tsx` 存在两条 3000+ 字符的巨型单行 JSX

**位置**：`src/features/knowledgeLibrary/KnowledgeLibraryPage.tsx:319`、`:321`（全文件 324 行 / 43,589 字节）

**现象**：`panel === "manage"` 与 `panel === "conflicts"` 两个分支各写成一行、长度超过 3000 字符的 JSX，包含按钮组、说明段落与多条件渲染。文件合计 53 个 `useState` / `useRef`。

**影响**：这两行是本次审查中**唯一无法被常规工具完整读出**的内容（多轮被截断，需用 `awk ... | tail -c` 才能补齐尾部）。任何 diff、code review、AI 辅助修改在此处都会失真——一个字符的改动会以"整行重写"的形式出现在 diff 里，历史不可读。同时 53 个 state/ref 集中在一个组件，`busyRef` 防重入以外的并发路径难以用阅读方式穷尽。

**建议**：将两个面板各抽为独立组件（如 `KnowledgeManagePanel.tsx` / `KnowledgeConflictPanel.tsx`），props 显式传递；`KnowledgeLibraryPage.tsx` 只保留路由与状态编排。此项不改变行为，但要补一条渲染快照或 e2e 断言，确保抽取无回归。

## P1-2 `pull` 中 `working.revisions` 的过滤基准是 `before` 而非 `remote`

**位置**：`src/features/knowledgeLibrary/sync.ts:122`

**现象**

```ts
working.revisions = {
  ...Object.fromEntries(Object.entries(before.revisions)
    .filter(([, revision]) => working.entities[revision.entityId])),
  ...working.revisions,
};
```

意图应是"清理掉实体已不存在的悬挂版本"，但过滤用的集合是本地 `before.revisions`，而 `working` 是从 `remote` 派生的。若远端引入了本地 `before` 中不存在的新版本，这些版本不会被这一轮清理覆盖到（虽然它们的实体必然在 `working.entities` 里，通常不会悬挂）。

**影响**：与 `repository.ts:43` 的"不可变知识版本不能覆盖"守卫叠加时，可能出现"某一轮 pull 写入了本应被清理的悬挂 revision"，触发后续 `writeKnowledgeStateDelta` 抛错或需要额外一轮清理。属于**边界条件下的状态残留**，未见测试覆盖该具体路径（`sync.test.ts` 的 replay 用例断言的是"无残留"，但未构造"远端新增版本 + 本地实体已删"的组合）。

**建议**：把过滤基准改为 `working.revisions`（即远端派生结果），或对两侧取并集后再按 `working.entities` 过滤：

```ts
const merged = { ...before.revisions, ...working.revisions };
working.revisions = Object.fromEntries(
  Object.entries(merged).filter(([, r]) => working.entities[r.entityId]),
);
```

并补一条"远端新增版本 + 本地实体缺失 ⇒ 该版本不得残留"的用例。

## P1-3 导入路径用 `expected[unit] = null` 显式绕开 strict 校验

**位置**：`src/features/knowledgeLibrary/import.ts:52`

**现象**：为导入候选生成 `editKnowledgeEntity` 后，直接写 `edit.expected[revision.unit] = null;`，使该命令在 `applyKnowledgeCommand` 中走**非 strict** 分支（对照 `protocol.ts:283` 的 `strict && expected !== currentId → stale`）。

**影响**：导入是本模块唯一会**批量写入大量命令**的入口，也是唯一绕过 strict 的入口。绕过之后，`protocol.ts:321-325` 的"非 strict position 冲突回退"路径会被激活——即 `entity.units[unit] = currentId!; conflict = true;`，生成一个未解决冲突组，而不是拒绝。这在导入场景下是**有意设计**（保留未解决候选，`import.test.ts` 有"保留未解决候选 2 个 `consumedBy === null`"的断言），但风险在于：`edit.id` 用 `knowledgeHash({ sessionId, candidateId })` 生成，`sessionId` 由 `prepareKnowledgeImport` 产出，若同一份源库被导入两次，两条路径的 `expected` 均为 `null`，**冲突组的生成是否会叠加**取决于 `groupIdentity` 的确定性——这一点没有对应测试。

**建议**：保持现有语义（这是产品决策），但补两条用例：①同一源库连续导入两次，第二次必须产生确定性的（而非累积的）冲突组；②导入过程中源库被他人并发修改 position，冲突组必须只保留一份可消费候选。若是明确不需要支持，也应在注释中写明"导入不做 strict 校验是有意为之"。

## P1-4 `applyKnowledgeCommand` 每条命令全量 `structuredClone(before)`

**位置**：`src/features/knowledgeLibrary/protocol.ts:270`

**现象**：`const state: KnowledgeState = structuredClone(before);`——在 `validateKnowledgeCommand` 与各项前置校验之后，对**整个状态**（含全部 `entities` / `revisions` / `candidates` / `groups` / `receipts`）做一次深拷贝，之后只改其中一个实体的少数 `unit`。

**影响**：单条命令的开销与库总规模线性相关。这在 `synchronize` 的循环里会被放大：每轮 `pull` 需要回放全部 pending 命令（`sync.ts` 的 pending 回放分支），导入时更是逐条命令执行。`protocol.test.ts` 覆盖了"10000 次种子 orderKey 有界"与"最大文本只写一次"，但**没有规模化的性能门槛断言**，因此这类退化不会被测试发现。当前库规模下不构成故障，但属于"随数据增长而恶化"的结构性成本。

**建议**：改为结构化共享（`state = { ...before, entities: { ...before.entities, [id]: entity } }` 形式的路径拷贝），或在 `synchronize` 的批量回放中改为一次性克隆、循环内原地修改。若要保留全量克隆以求简单，建议补一条"10000 实体下单命令耗时上限"的基准断言，把退化显式化。

## P1-5 非空断言（`!`）集中在关键路径，缺少运行时不变量保护

**位置**（本次审查定位到的代表性点位）：

| 文件 | 行 | 断言对象 |
|---|---|---|
| `src/features/knowledgeLibrary/autoBackup.ts` | 27 | `(await db.knowledgeSyncState.get(library.id))!.dirtyGeneration` |
| `src/features/knowledgeLibrary/repository.ts` | 209 | `updated!` |
| `src/features/knowledgeLibrary/presentation.ts` | 53、82 | `nodes.get(...)!` / `spans.get(...)!` |
| `src/features/knowledgeLibrary/KnowledgeMap.tsx` | 157 | `byId.get(node.parentId)!`（两处） |
| `src/features/knowledgeLibrary/KnowledgeDetails.tsx` | 22 | `event.currentTarget.closest("details")!`（两处） |
| `src/App.tsx` | 566 | `knowledgeOriginsRef.current.pop()!` |
| `src/features/knowledgeLibrary/import.ts` | 48 | `revisionValue(sourceState, revision.id)!` |
| `src/features/knowledgeLibrary/query.ts` | — | `recordToPlainText(record)` 调用链 |

**影响**：`autoBackup.ts:27` 那处最值得注意——它在**备份冻结事务内**读取 `dirtyGeneration`，若某个库的 `knowledgeSyncState` 行缺失（例如库刚创建、`syncState` 尚未写入，或历史数据经 purged 而不完整），会抛 `TypeError` 而不是 `KnowledgeError`。`KnowledgeError` 会被 `uiError.ts` 分类成可读文案并有恢复路径；裸 `TypeError` 则会落到通用兜底，用户只看到无信息量的错误。`App.tsx:566` 的 `.pop()!` 由前一行的 `.length` 守卫保护，属于可接受但脆弱的写法。

**建议**：按"是否可能缺失"分档处理——`autoBackup.ts:27` 应改为显式判定并抛 `KnowledgeError("missing", ...)`（或按 0 处理），使其进入既有的错误分类与恢复链路；纯几何计算的 `presentation.ts` 断言可保留，但建议在函数入口加一条不变量断言（`nodes` 必须包含全部 parent），把"数据已损坏"与"算法有 bug"区分开。建议顺带加一条 lint 规则（本仓库可用 ESLint 插件）对 `knowledgeLibrary/` 目录下的 `!` 做白名单管理。

## P1-6 `KnowledgeMap` 的 `useMemo` 依赖数组不完整，且以可变 ref 参与派生

**位置**：`src/features/knowledgeLibrary/KnowledgeMap.tsx:22`、`:33-35`

**现象**

```ts
const sides = useRef(navigation.mapWorkspaceId === workspaceId ? navigation.mapSides ?? {} : {});
const layout = useMemo(
  () => layoutKnowledgeMap(state, workspaceId, new Set(navigation.collapsed), sides.current),
  [state, workspaceId, navigation.collapsed],   // 读取了 sides.current，但不在依赖里
);
const frozen = useRef(layout.nodes);
if (!gesture.current) frozen.current = layout.nodes;   // 渲染期写 ref
const latest = useRef({ view, onNavigation, layout });
latest.current = { view, onNavigation, layout };       // 每次渲染写 ref
```

**影响**：`sides.current` 被 `useMemo` 闭包读取但不在依赖数组中，属于典型的"依赖不完整"。当前之所以不炸，是因为 `sides` 只在 `mapWorkspaceId !== workspaceId` 时变化、而那时 `workspaceId` 变化会同时触发重新计算——**依赖恰好被另一个依赖项掩盖**。这种"靠巧合正确"的写法在后续微调 props 拆分时极易被破坏。`frozen.current` 在渲染期条件写入 与 `latest.current` 在渲染期无条件写入，则属于 React 严格模式下的不推荐模式（并发渲染时可能读到跨渲染的值）。

**建议**：把 `sides` 纳入依赖（或改为 `useMemo` 内直接计算 `const sideMap = navigation.mapWorkspaceId === workspaceId ? navigation.mapSides ?? {} : {}`，不再用 ref）；`frozen` 与 `latest` 的写入移入 `useEffect`，或在并发渲染不敏感的当前 React 版本上至少加注释说明为何安全。补一条"切换工作区后侧向偏好必须立即生效"的用例。

## P1-7 搜索路径 `recordToPlainText(record)` 未传 `assets`

**位置**：`src/features/knowledgeLibrary/query.ts`（`searchKnowledge` 的 `bodyCache` 计算处）

**现象**：`recordToPlainText(record)` 不传第二个 `assets` 参数，与 `src/components/RecordCard.tsx:40` 的写法一致。

**影响**：本次审查确认这是一个**全仓库一致的选择**（两处都这么写），而非知识库独有的疏漏。但后果在知识库侧更明显：`knowledge-json` 导出的 helper 文案明确承诺"保留…图片 OCR 文本"，而**知识库内搜索**对同一份日志的 OCR 文本不可命中。用户看到导出里有的内容搜不到，属于可观测的不一致。

**建议**：确认产品意图。若"搜索不索引 OCR 文本"是有意为之（例如性能考量），应在 `query.ts` 加注释并在 UI 上不宣称可搜索 OCR；否则统一改为传入 `assets`，并在 `knowledge-library.spec.ts` 补一条"OCR 文本可被搜索命中"的 e2e 断言。**不建议只改知识库这一处**——若两处应一致，就一起改。

## P1-8 导出项命名与实际内容不符：`"知识库 JSON"` 不含知识库组织

**位置**：`src/pages/AiExportPage.tsx:16-30`、`src/services/knowledgeExportService.ts:67-72`、`:290-296`

**现象**

- 导出项 label 为 **"知识库 JSON"**，helper 文案为"保留日期、学科、正文、公式、资源标题和图片 OCR 文本，方便后续接本地知识库问答"。
- 实际 payload 由 `createKnowledgeJsonPayload` 生成：`{ format: "study-journal-knowledge", version: 1, exportedAt, records: createKnowledgeRecords(snapshot) }`——只有**日志的扁平记录**，**不含**知识库的专题、大纲结构、节点引用、备注（这些在 `full-backup` 的 v7 envelope 里，见 `storageAdapter.ts:2356` / `:2369` 的 `capturePortableKnowledge` 与 `version: includeKnowledge ? 7 : 6`）。

**影响**：在知识库功能上线后，"知识库 JSON"这个标签会产生**直接误导**：用户期望导出的是他刚在知识库面板里组织的结构，拿到的却是一份日志清单。这不是死代码——它与新功能重名且语义冲突，属于**文档/命名层面的实际缺陷**。

**建议**：优先级取决于是否会被真实用户误解。建议二选一：①将 label 改为"日志知识 JSON"或"AI 问答 JSON"，消除与知识库模块的命名碰撞；②或让该导出真正包含知识库结构（但会与 `full-backup` 职责重叠，需先明确边界）。无论哪种，都应在 `CHANGELOG` 与 `AGENTS.md` 记录取舍。

---

# 建议的修复顺序

| 顺序 | 项 | 理由 |
|---|---|---|
| 1 | **P0-1** | 一行代码量级，消除唯一的原型污染面，且与其他三处净化对齐 |
| 2 | **P0-3** | 修正事实权威文档，避免后续所有人（含 AI）被带偏 |
| 3 | **P0-2** | 需要设计决策（方案 A 或 B），但必须在下次同步改动前定 |
| 4 | P1-2 / P1-3 | 同属状态一致性，建议与 P0-2 一起在一轮"同步正确性"改动中处理并补用例 |
| 5 | P1-8 / P1-7 | 用户可观测的命名与行为不一致，改动小、收益直接 |
| 6 | P1-1 | 可维护性，纯重构，但能为后续所有知识库改动降本 |
| 7 | P1-5 / P1-6 | 健壮性，建议配合 lint 规则一次性治理 |
| 8 | P1-4 | 性能，待节点规模确认后再动 |

---

*本报告基于 5 个提交的静态源码审查，未执行构建与测试。所有行号对应审查时的仓库状态（`HEAD = c9f4b68`）。*
