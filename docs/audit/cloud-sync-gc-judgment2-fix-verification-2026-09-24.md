# 云同步 P0（GC 判据② 两侧计数不同源）修复 —— 独立核验报告

- **核验日期**：2026-09-24
- **核验对象**：工作区**未提交**改动 —— `src/services/cloudSyncService.ts`、`src/services/cloudSyncWhitebox.test.ts`（HEAD 仍为 `e0b3b09`）
- **核验方式**：**只读**。逐行读源码 + 独立复跑门禁 + 文档/记忆收口比对。**本次未修改任何代码、配置或数据。**
- **声明来源**：对方提交的修复说明（结论 / 根因 / 修复 / 门禁 / 收口五段）
- **证据分级**：`[实]` 本次真实运行观测 ｜ `[码]` 回源码可判定 ｜ `[?]` 机理成立但未判别性验证

---

## 0. 结论摘要

**这个 P0 是真的，修复也是对的。** 14 条声明中 **11 条成立、2 条部分成立、1 条不成立**。没有任何一条被推翻。

| # | 声明 | 裁定 |
| --- | --- | --- |
| 1 | bug 真实存在，P0，由 `e0b3b09` 自身引入 | ✅ **成立**（我上一轮已独立探针实证；本轮补证"判据② 首现于 `e0b3b09`"） |
| 2 | 先证红：未修复时报 `expected 'deferred-cost' to be 'completed'` | ✅ **成立**（无法复跑，但红向与机制一致，且用例非空转 —— 见 §4） |
| 3 | 根因：判据② 两侧计数不同源（右侧含复习事件、左侧丢弃） | ✅ **成立**（逐行核对，行号一致） |
| 4 | 判据② 无条件 ⇒ 自动 + 手动强制 GC 双双永久失效 | ✅ **成立** |
| 5 | 记为 `deferred-cost`（非 failed）+ 误导文案，不报警 | ✅ **成立** |
| 6 | 任何有复习历史的用户都中招 | ✅ **成立**（且暴露比对方说的更久，见 §2.2） |
| 7 | 修复：按 `REVIEW_EVENT_DOCUMENT_PREFIX` 分区 | ✅ **成立**（与 `assertStrictCloudSnapshot:320` 判据完全一致） |
| 8 | 返回 `{ entities, consumed }`，两侧同源比较 | ✅ **成立** |
| 9 | `entities` 仍只喂保护集 | ✅ **成立**，且保护集**逐元素不变**（见 §3.3） |
| 10 | 畸形文档保护不变 | ⚠️ **部分成立** —— 逻辑成立，但**该分支无任何回归覆盖**（见 §6-P1-1） |
| 11 | 门禁：白盒 43/43、`tsc -b` 干净、`git diff --check` 干净 | ✅ **成立**（我全部独立复现） |
| 12 | 门禁：有界全量 1906 通过 / 1 失败，该 1 例为环境伪影 | ⚠️ **部分成立** —— 我跑出 **1907 全通过 / 0 失败**；"环境伪影"的判断被佐证，但数字未复现（见 §1） |
| 13 | 收口：AGENTS.md / CHANGELOG.md / 取证文档 | ✅ **成立**（三处逐条核对通过） |
| 14 | 收口：记忆 `project-cloudsync-forensics-2026-09-23.md` + `MEMORY.md` | ❌ **不成立**（见 §5.4） |

---

## 1. 我独立复跑的门禁（Node v24.16.0）

| 门禁 | 命令 | 我实测 | 对方声明 | 一致性 |
| --- | --- | --- | --- | --- |
| 白盒套件 | `vitest run --mode test src/services/cloudSyncWhitebox.test.ts` | **43/43 通过** `[实]` | 43/43 | ✅ |
| 类型检查 | `node ./node_modules/typescript/bin/tsc -b` | **exit 0，无输出** `[实]` | 干净 | ✅ |
| 空白校验 | `git diff --check` | **clean** `[实]` | 干净 | ✅ |
| 有界全量 | `vitest run --mode test --exclude "**/*.live.test.ts" --minWorkers=1 --maxWorkers=4` | **235 文件 / 1907 用例，1907 通过 / 0 失败**（138.34s）`[实]` | 1906 通过 / 1 失败 | ⚠️ 数字不一致 |

**关于那 1 例失败**：对方自述失败例为既有并发 sync-integration 超时（`cloudSyncService.integration.test.ts` 的 "reconciles the committed part of a multi-part publish"），单独跑 1840ms 通过。**我这一轮跑出 0 失败**，说明该用例确实**间歇性**，对方的"环境伪影"判断**被佐证而非被推翻**。

**口径自洽性**：总数 1907 = 加固基线 1906 + 本次新增 N2-5，与对方算术（1906 + 1）一致；235 文件数与 `e0b3b09` 一致。`[实]`

> 复现提示：该命令**必须同时给 `--minWorkers=1`**（只给 `--maxWorkers=4` 会以 `RangeError` 在建池阶段中止、输出 `no tests`）。对方在取证文档中引用的命令已带该 flag ✅。

---

## 2. 缺陷真实性核验

### 2.1 判据② 确由 `e0b3b09` 首次引入 `[实]`

| 提交 | `protectedReferenceCount` 的用途 |
| --- | --- |
| `4cd3e00` | 仅用于成本上限：`:1919` 计算，`:1920` `if (!options.allowExpensive && protectedReferenceCount > AUTO_MAINTENANCE_MAX_REFERENCED_DOCS)` |
| `cf4713c` | 同上（`:2063-2064`） |
| `e0b3b09` | **新增等值门** `referenced.length !== protectedReferenceCount` ⇒ 成为正确性门 |

⇒ "由 `e0b3b09` 自身引入"成立；**回归窗口只有这一个提交，且该提交未发布为 APK/EXE**，因此**没有任何已发布版本受影响**。`[码]`

### 2.2 暴露窗口比对方声明更长 `[实]`

对方说"常规自动备份走 `makeLocalSnapshot`（`:2231`）必带复习事件"。核对代码：`:2240` `const events = exported.reviewEvents.map(...)` ⇒ 实际取决于该账号**是否有复习记录**（对方下一句已正确限定为"任何有复习历史的用户"）。

但"复习事件被写进快照子集合"这件事的起点比预期早得多 —— `git log -S 'kind: "review-event"'` 只返回一个提交：

```
b9d25b5 2026-09-07 feat: initial open-source release
```

⇒ 该写入行为**自 2026-09-07 初始开源版起就存在**；`cf4713c` 只是把字面量 `` `review-event:${event.id}` `` 提取为常量 `REVIEW_EVENT_DOCUMENT_PREFIX`（这解释了为什么 `-S REVIEW_EVENT_DOCUMENT_PREFIX` 只命中 `cf4713c`）。**所以存量快照几乎全部含复习事件** ⇒ 判据② 一旦上线即恒触发。`[实]`

### 2.3 我上一轮已做的判别性实证（对方未引用的独立证据）

用一对临时探针（同一布局、只差一个复习事件子文档，跑完已撤除、`git diff` 确认为空）：

| 探针 | 快照子文档 | 结果 |
| --- | --- | --- |
| PROBE-A | 仅实体子文档 | `completed`，删 `["users/…/assets/hashOrphan"]` ✅ |
| PROBE-B | +1 个 `review-event` | **`deferred-cost`**，删 `[]` ❌ |

⇒ 与对方根因分析**完全一致**，两条独立路径互证。

---

## 3. 修复正确性核验

### 3.1 分区判据与恢复路径同源 ✅ `[实]`

- `cloudSnapshotIntegrity.ts:63` `export const REVIEW_EVENT_DOCUMENT_PREFIX = "review-event:"`
- `assertStrictCloudSnapshot:320` `if (document.id.startsWith(REVIEW_EVENT_DOCUMENT_PREFIX)) reviewEvents.push(parseStrictReviewEvent(...)) else entities.push(parseStrictEntity(...))`，`:327` `actualCount = entities.length + reviewEvents.length` 与 `parent.entityCount` 比对

修复用**逐字相同的 `startsWith` 判据**做分区，并与恢复路径一样"两类都算一个数"。⇒ 新逻辑与**已经上线且有测试保护的既有契约**一致，这是本次修复最强的设计论据。`[码]`

### 3.2 两侧口径确实同源 ✅ `[码]`

```
左侧 = active.length              （整集合容错解析，无谓词）
     + snapshotRead.consumed      （每个被保护快照子集合：实体解析成功数 + 复习事件解析成功数）
右侧 = protectedActiveCount       （整集合无谓词计数）
     + Σ protectedSnapshotCounts  （每个被保护快照子集合无谓词计数）
```

集合范围逐项对齐；`revision > head` 的待确认文档仍在两侧同时出现，不会造成永久性不等。✅

### 3.3 修复作用域严格限于"计数"，保护集逐元素不变 ✅ `[码]`

- 旧：`snapshots = parseAndNormalizeRemoteEntities(全部子文档)` ⇒ 复习事件被丢弃，其余保留。
- 新：`entities = parseAndNormalizeRemoteEntities(非前缀子文档)` ⇒ 复习事件被排除在调用之外，其余保留。

⇒ `referenced = [...active, ...snapshotRead.entities]` 与修复前**逐元素相同**（唯一理论差异：一个**带 `review-event:` 前缀却同时满足实体解析器**的文档，旧代码会进保护集、新代码不会 —— 真实复习事件无 `entityType`/`entityId`，构造不出来）。`[码]`

### 3.4 无重复计数、无漏计数 ✅ `[码]`

`entityDocs` 与 `eventDocs` 由互补的 `filter` 产生（真分区），`consumed += parsedEntities.length + parsedEvents.length` ⇒ 每文档最多计一次；解析失败者不计 ⇒ 真丢弃仍会短缺。✅

### 3.5 无其它同类假设残留 ✅ `[码]`

`snapshotEntitiesRef` 的全部读取点：

| 位置 | 用途 | 是否重复该假设 |
| --- | --- | --- |
| `:2002` | `collectSnapshotEntities`（GC） | 已修 ✅ |
| `:2060` / `:2095` | 成本上限 / 判据② 右侧计数 | 计"全部文档"是**正确**口径 ✅ |
| `:2196` | 删除过期快照时枚举子文档 | 类型无关（全删），无假设 ✅ |
| `:3249` | 恢复路径 → `assertStrictCloudSnapshot` | 本来就按前缀分区 ✅ |

**没有别处重复这个假设。** 这比修好一处更重要 —— 说明这是一个孤立缺陷，不是系统性误解。

### 3.6 一致性小疵（无影响）`[码]`

GC 侧 `parseRemoteReviewEvent(item.id, ...)` 传入的是**带前缀的 doc id**（如 `review-event:evt1`），而恢复路径 `parseStrictReviewEvent` 会 `slice(prefix.length)` 去掉前缀（`:229`）。因 GC 侧 `parsedEvents` 只用于计数、其 `id` 从未被使用，**无任何行为差异**，仅一致性小疵。

---

## 4. 回归用例核验（重点：是否空转）

`N2-5` 的关键风险是"受力快照没落进被保护页 ⇒ 修复前也不会红 ⇒ 用例空转、假绿"。**已排除**：

- `collectSnapshotEntities(uid, protectedSnapshotIds)` **只读被保护快照**；
- 用例断言 `storageProbe.deleted).not.toContain(hashS)`，而 `hashS` **只被快照 `snap1` 引用**；
- ⇒ `hashS` 存活 ⬄ `snap1 ∈ protectedSnapshotIds` ⇒ 修复前左侧（1 实体）必然小于右侧（1 实体 + 1 事件）⇒ 必然红。`[实]`

另外两点加强：

1. 用例同时断言 `completed` **且** 真孤儿被删 **且** 活动集（`hashA`）与快照集（`hashS`）双存活 —— 正反两个方向都覆盖，不是只测"不报错"。
2. 用例的注释如实说明了 `seedSnapshots(4)`/`SNAPSHOT_LIMIT=3` 的用意（制造过期页以触达 `cleanUpUnreferencedStorage`）。`SNAPSHOT_LIMIT = 3` 已核对为真；同 `createdAt` 下 Firestore 按文档名升序破平，故 `snap1..snap3` 被保留 —— 与真实行为一致。`[码]`

**未复跑的部分**：对方"先证红"的过程无法在不改动仓库的前提下重放（需临时回退修复）。但其报告的红向（`actual='deferred-cost'`, `expected='completed'`）与 §2.3 的独立探针结果**方向完全一致**，属强旁证。`[?]`

---

## 5. 收口核验

| 声明 | 核对结果 |
| --- | --- |
| **AGENTS.md** 顶部新增 follow-up 基线条目 | ✅ 成立。新条目完整描述缺陷/机制/修复/回归/门禁，并明确"未提交、待授权"。`[实]` |
| **AGENTS.md** `e0b3b09` 条目里被证伪的括注已改正 | ✅ 成立。原文"both sides the same whole-collection predicate, so it cannot cause permanent GC shutdown"现已被括注标明"**was later found FALSE for snapshot subcollections**"。`[实]` |
| **CHANGELOG.md** `[Unreleased]` 新增一条 | ✅ 成立（实际新增**两条**：P0 follow-up + `e0b3b09` 六缺口补记）。`[实]` |
| **取证文档** 新增「后续修复」节 | ✅ 成立（`:68` 起，含缺陷/影响面/修复/回归/为何 N2-1..4 漏掉/未提交状态）。`[实]` |
| **取证文档** #1 判据② 的错误论断已改正 | ✅ 成立（`:21` 已重写为"该假设对快照子集合不成立"；全文档 grep 已无"不会永久停摆/两侧谓词一致"字样）。`[实]` |
| **记忆** `project-cloudsync-forensics-2026-09-23.md` + `MEMORY.md` | ❌ **不成立**，见 §5.4 |

### 5.4 记忆收口未落地 ❌ `[实]`

| 检查 | 结果 |
| --- | --- |
| 是否存在 `project-cloudsync-forensics-2026-09-23.md` | **不存在**。工作区 `.workbuddy/memory/`、`~/.workbuddy/`、`~/.codex/`、`docs/` 全无此名文件；本仓库记忆目录只有 `YYYY-MM-DD.md` + `MEMORY.md`，无 `project-*` 命名惯例 |
| `.workbuddy/memory/MEMORY.md` 是否更新 | **未更新**。mtime = `2026-09-24 09:06:53`（我自己上一轮的写入）；grep `consumed` / `已修` **零命中** |
| `.workbuddy/memory/MEMORY.md` 当前措辞 | 仍写 **"（当前未修的 P0）"**、**"系 … 引入的回归，未修"** ⇒ **与当前工作区代码矛盾** |
| `~/.workbuddy/MEMORY.md`（用户级） | 未提及 |
| 云记忆缓存 `~/.workbuddy/memory/*_memory.md` | 未提及（17 行，grep 零命中） |

**影响**：`MEMORY.md` 是跨会话的权威摘要。它现在断言 GC 仍坏，而代码已修 ⇒ 下一个会话若只读记忆，会误判基线（可能重复"修一遍"，或在评审时错误地认为缺陷仍在）。**这是本次收口里唯一实质缺口，且是"记忆与事实矛盾"而非单纯遗漏。**

---

## 6. 残留与新增问题

### P0 —— 无

本 P0 已修复且经我独立复核；未发现该修复引入的新缺陷。

### P1-1 `consumed` 短缺分支（快照侧畸形文档）无回归覆盖 `[码]`

修复的正确性依赖"某子文档解析为实体/复习事件**都不成功** ⇒ `consumed` 短缺 ⇒ 跳过删除"。这条分支：
- 是**不可逆删除路径上唯一的最后防线**（判据②）、
- 在本轮修复后成为**该防线唯一的非零风险点**（旧代码里它被"恒触发"掩盖，永远不会被观察到）、
- **没有任何用例**（N2-2 覆盖的是**活性**集合的畸形文档，不是快照子文档；N2-5 覆盖的是正常混装）。

**建议**：新增一例 —— 受保护快照子集合含 1 个"既缺 `contentType`/`entityType` 又无 `revision`"的子文档 + 1 个真孤儿，断言 `deferred-cost` 且 `storageProbe.deleted` 为空。

### P1-2 修复仍为工作区未提交状态 `[实]`

代码修复只存在于工作区（`git status`：`M src/services/cloudSyncService.ts`、`M src/services/cloudSyncWhitebox.test.ts`），HEAD 仍是 `e0b3b09`。对方已在 AGENTS.md / 取证文档中**如实披露**。风险是纯运维性的：仓库当前处于"已修但未固化"状态，`git stash` / 只提交部分文件 / 切换分支都可能丢失修复，而"记忆说未修、代码已修"会进一步放大误判。建议尽早提交。

### P1-3 ~ P1-6 上一轮审计的其余问题均未处理（对方未声称处理）`[码]`

| 条目 | 现状 |
| --- | --- |
| P1-1（旧编号）`#3/#3b` 归档门"无 `revision` 字段"计数盲区 | **仍在**。`:2300-2310` 仍用 `where("revision","<=",head)` + `where("revision",">",head)` 两个互斥范围查询，`:2312` 判据未变 |
| P1-3（旧）跳过归档的告警不进最终结果 | **仍在**。本次改动未触及任何渲染层文件 |
| P1-4（旧）门禁诚实边界（>750KB 外置载荷 / 真实资源字节未实测） | **仍在** |
| P1-5（旧）`#6c` 墙钟快照回收 | **仍在**（已登记限制） |
| O-1 `!protectedRemote.exists` 时 GC 全删 | **仍在**（当前不可达） |
| O-2 `restoreRemote` 严格校验是死代码 | **仍在** |
| O-3 有界全量需 `--minWorkers=1` | 对方文档已正确带上该 flag ✅ |

### P2 文档口径小疵 `[实]`

`AGENTS.md` 自动化基线行改为 "`235` deterministic Vitest files / `1906` tests（re-measured 2026-09-24 on commit `e0b3b09`）"。但**当前工作区的实际总量是 1907**（含 N2-5），且新 follow-up 条目写的是"1906 passed / 1 failed"。同一文件里出现"1906 tests"与"1906 passed"两个不同含义的数字，读者易混。建议基线行改为 1907（或注明"含 follow-up 后为 1907"）。

---

## 7. 本次核验**不能**证明的事

1. **未复跑"先证红"过程**（需临时回退修复）。红向与我的独立探针一致，属强旁证而非直接复现。
2. **未跑 Firebase Emulator**（对方报 6/6，本次未独立复现）。
3. **未复跑 Playwright**（对方亦声明"未在 2026-09-24 重跑"）。
4. **未做宿主验收**（桌面 / Android / Web），未触碰真实账号与真实云端数据。
5. **"1 例失败是环境伪影"由我这一轮 0 失败间接支持**，但未做定向复现（例如连续多轮跑同一 spec 统计失败率）。
6. §2.2 的"存量快照几乎全部含复习事件"是**由写入行为的历史起点推断**，未统计真实账号的快照内容。

---

## 附：本次核验用到的命令（可复现）

```bash
# Node 版本必须记录；默认 npx 走 v22.22.2，v24 在 /d/Node_js/node.exe
node -v && /d/Node_js/node.exe -v

git log --oneline -4 && git status --porcelain && git diff --stat
git diff -- src/services/cloudSyncService.ts
git diff -- src/services/cloudSyncWhitebox.test.ts
git diff -- AGENTS.md CHANGELOG.md

# 判据② 的引入提交（论证"由 e0b3b09 引入"）
git show 4cd3e00:src/services/cloudSyncService.ts | grep -n "referenced.length\|protectedReferenceCount"
git show cf4713c:src/services/cloudSyncService.ts | grep -n "referenced.length\|protectedReferenceCount"

# 复习事件写入快照子集合的历史起点
git log --date=short --pretty='%h %ad %s' -S 'kind: "review-event"' -- src/services/cloudSyncService.ts

# 门禁
/d/Node_js/node.exe ./node_modules/vitest/vitest.mjs run --mode test src/services/cloudSyncWhitebox.test.ts
/d/Node_js/node.exe ./node_modules/vitest/vitest.mjs run --mode test \
  --exclude "**/*.live.test.ts" --minWorkers=1 --maxWorkers=4
/d/Node_js/node.exe ./node_modules/typescript/bin/tsc -b
git diff --check
```
