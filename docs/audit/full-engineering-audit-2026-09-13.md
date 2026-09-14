# StudyJournal 全规模工程审查报告

> 审查日期：2026-09-13
> 审查性质：**只读审查，未修改任何源码 / 配置 / schema / 构建脚本，未提交任何 commit。**
> 唯一例外：为验证生产构建可用性，向 `dist-verify/`（临时输出目录）写入过构建产物。

---

## 1. 审查基线

### 1.1 拉取远端结果（重要说明）

按要求先执行拉取，**未能成功**：

```
$ git fetch --all --tags
fatal: unable to access 'https://github.com/a1234tuan/StudyJournal.git/':
       CONNECT tunnel failed, response 502
$ git ls-remote --heads origin
fatal: unable to access '...': CONNECT tunnel failed, response 502
```

当前环境无法直连 GitHub（代理隧道返回 502）。因此：

- 远端**未被拉取**，本次审查基于本地工作区。
- `git branch -vv` 显示 `main` 与 `origin/main` 一致（基于最后一次成功 fetch 的引用），无法排除远端有更新的 commit。
- **若远端已有新提交，本报告的结论需要以新 commit 重新核对。**

### 1.2 基线 commit

| 项目 | 值 |
| --- | --- |
| 分支 | `main`（另有 `audit-fixes` @ `8fc0692`） |
| HEAD | `829f98d68dee2464784bba45477a393ea996bbae`（短号 `829f98d`） |
| commit 时间 | 2026-09-12 19:36:18 +0800 |
| 作者 | codelcz |
| commit message | `fix(sync): keep AI and TTS settings device-local` |
| tag | `v0.2.3` |
| 工作区状态 | 干净（仅 `.workbuddy/`、`docs/audit/`、`img/`、`output/` 未跟踪） |

### 1.3 工程度量

| 指标 | 数值 |
| --- | --- |
| 源码文件（`src/**/*.{ts,tsx}`） | 385 |
| 源码行数 | 80,294 |
| 含 CSS 的 `src` 总行数 | 94,965 |
| 测试文件 | 164 |
| 测试代码行数 | 24,407（占 src 的 30%） |
| `src` 目录数 | 11（components / db / features / hooks / lib / pages / preview / services / styles / test） |

最大的 10 个源文件：

| 行数 | 文件 | 备注 |
| --- | --- | --- |
| 2881 | `src/services/cloudSyncService.ts` | **本轮排除** |
| 2328 | `src/services/storageAdapter.ts` | 本地持久化核心 |
| 2119 | `src/components/RichTextEditor.tsx` | 富文本编辑器 |
| 1821 | `src/App.tsx` | **根组件（77 KB）** |
| 1520 | `src/pages/ReviewPage.tsx` | |
| 1332 | `src/features/reviewCoach/repository.ts` | |
| 1266 | `src/pages/RecordEditorPage.tsx` | |
| 1125 | `src/features/voiceRecall/VoiceRecallWorkspace.tsx` | |
| 1121 | `src/types.ts` | |
| 1086 | `src/hooks/useAppData.ts` | 中心状态钩子 |
| 47953 B | `desktop/main.cjs` | Electron 主进程 |

### 1.4 只读验证结果（确定性证据）

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc -b` | ✅ **零错误**（无输出） |
| 单元测试 | `npx vitest run` | ✅ **162 个文件通过 / 1015 个用例通过 / 2 个 live 测试按要求跳过** |
| 生产构建 | `npx vite build --outDir dist-verify` | ✅ 成功，4904 个模块 |
| 首次 `vite build` | `npx vite build` | ⚠️ 仅因**本审查环境**的批量删除保护拦截清空 `dist/`（137 个文件 > 阈值 50）；**非项目缺陷** |

构建产物体积：

| 产物 | 大小 | gzip |
| --- | --- | --- |
| `index-*.js`（主包） | **2,478.63 kB** | 709.38 kB |
| `cynefin-*.js`（mermaid 图表类型） | 690.83 kB | 155.11 kB |
| `mermaid.core-*.js` | 606.91 kB | 144.13 kB |
| `editor-*.js`（Tiptap） | 458.16 kB | 141.79 kB |
| `cytoscape.esm-*.js` | 443.72 kB | 142.36 kB |
| `math-*.js`（KaTeX） | 261.33 kB | 77.57 kB |
| PWA 预缓存 | 109 个文件 / **19,548 KiB ≈ 19 MB** | — |

### 1.5 明确排除的范围

按你的要求，以下两块**未纳入审查**：

- **云同步逻辑**（`src/services/cloudSyncService.ts` 内部实现、`cloudSyncModel.ts` 同步模型、租约锁、冲突解决）
- **自动备份逻辑**（`src/services/autoBackup*`、`nativeAutoBackup*`、`nativeRepositoryBackupService`）

只做了边界性读取（例如确认 `createSnapshot()` 被四个通道共用），未审查其内部策略。

### 1.6 代码卫生静态扫描（正面证据）

| 项目 | 计数 | 评价 |
| --- | --- | --- |
| `console.log/debug/info`（src，非测试） | **0** | 优秀 |
| `@ts-ignore` | **0** | 优秀 |
| `@ts-expect-error` | **0** | 优秀 |
| `eslint-disable` | **0** | 优秀 |
| `: any` / `as any`（非测试） | **0 / 0** | 优秀 |
| 真实 `TODO/FIXME/HACK` | **0** | 优秀 |
| `void `（fire-and-forget Promise） | 358 | 需关注 |
| `.catch(() => ...)` 兜底 | 67 | 需关注 |
| `.catch(() => undefined)` 静默吞错 | **58** | 与「错误不可见」问题同源 |
| `setInterval` / `clearInterval` | 3 / 3 | 平衡，无定时器泄漏 |
| `setTimeout` / `clearTimeout` | 70 / 67 | 基本平衡 |
| `addEventListener` / `removeEventListener` | 66 / 63 | 基本平衡（差额为 `{once:true}` 一次性监听） |

---

## 2. 项目总体健康度

### 结论：**良好**（偏「良好+」，但不是「优秀」）

理由分正反两面。

**支撑「良好」的证据：**

1. **零型别逃逸**：`@ts-ignore` / `@ts-expect-error` / `: any` / `as any` / `eslint-disable` **全部为 0**。在 8 万行 TypeScript 项目里这是极高的自律水平。
2. **`strict: true` 且真的做到了**：`tsc -b` 零错误。
3. **测试密度扎实**：164 个测试文件、1015 个用例全绿，23 个 schema 迁移测试覆盖 v16→v21 的升级与升级失败回滚。
4. **零调试残留**：`console.log` 为 0，无 TODO/FIXME。
5. **资源释放基本严谨**：定时器、监听器、AbortController 的清理配比基本平衡；组件卸载 abort 的模式在关键路径（AI 解释、语音会话）都有。
6. **安全规则正确**：`firestore.rules` / `storage.rules` 都以 `request.auth.uid == userId` 为边界；云函数 `getStorageUsage` 有 `context.auth` 校验 + `users/{uid}/` 前缀限定。
7. **无敏感文件入库**：`.env` / `keystore.properties` / `google-services.json` / `oauth-config.cjs` 全部未跟踪。
8. **预览/Mock 路由有守卫**：10 个 `?preview=` 入口中 8 个正确排除了原生与桌面平台。
9. **DB schema 演进有序**：v1→v21 逐版本 `stores()` 声明 + 迁移函数，且有迁移失败回滚测试。

**扣分的四个结构性因素：**

1. **无全局异常兜底**（无 ErrorBoundary、无 `window.onerror`、无 `unhandledrejection`）→ 任何未捕获异常即白屏且不可恢复。
2. **错误可见性系统性缺失** → 58 处静默吞错 + `normalizeUiError` 主动丢弃错误对象，导致「出了错但查不出原因」成为常态（这正是上一轮 ZIP 导出问题的根因）。
3. **中心化巨构**：`App.tsx` 1821 行 / 77 KB、`useAppData` 返回 ~80 个方法与 ~20 个状态数组、`ReviewPage` 接收 55 个 props、`storageAdapter` 2328 行。这是**当前最大的可维护性风险源**。
4. **工程基础设施缺口**：**完全没有 ESLint / Prettier**；`tsconfig` 只覆盖 `src`，`desktop/`、`e2e/`、`scripts/` 完全不在类型检查内；e2e 只覆盖 localhost 预览路由，**真实 Android/Electron 运行时零自动化测试**。

### 核心模块稳定度

| 模块 | 稳定度 | 说明 |
| --- | --- | --- |
| 本地持久化 / schema | 高 | 23 个迁移测试、事务边界清晰 |
| 复习 / FSRS | 高 | FSRS 参数传递经复核**正确**；撤销链路稳健 |
| 编辑器 / 富文本 | 中高 | 结构删除行为安全，但并发与卸载落库有缺口 |
| AI 能力 | 中 | 上下文组装干净（已确认无重复注入、正确排除已删记录），但截断/并发/默认值有问题 |
| Learning Coach | 中 | 状态机与投影设计合理，但重试与「建议入正式库」边界有缺陷 |
| 语音复述 | 中 | 闭环完整、麦克风互斥在原生层双向强制，但存在状态污染与配置双源 |
| 配置体系 | **中低** | **多套配置源并存，无单一事实源**（本报告最重的架构问题之一） |
| 桌面端 / 打包 | **中低** | 隔离配置与 asar 路径正确，但存在硬编码本机路径 |
| Android 平台 | 中 | 权限/返回键/键盘处理正确；**targetSdk 36 下的 insets 策略存疑** |

### 最大风险来源（按影响排序）

1. **错误不可见 + 无异常兜底** —— 让所有其他缺陷都变得难以发现和定位。
2. **备份通道整体脆弱** —— 完整性校验策略 + 孤儿资源误删，会让「最后一道数据防线」同时失效。
3. **配置体系多源分裂** —— 用户改了设置但某模块仍用旧值，且无对账机制。
4. **App.tsx / useAppData 巨构** —— 未来任何改动都容易引入回归。

### 是否适合进入收口阶段

**可以进入收口，但必须先完成 P0 项（见 §7）。**

当前代码的**质量下限很高**（类型严格、测试全绿、无调试残留），不是「一堆烂摊子需要重构」的状态。阻碍收口的不是「代码写得差」，而是**几处关键的可靠性兜底缺失**和**一处架构性的配置分裂**。这三类问题都**不需要大规模重构**就能修，属于「小改动、高收益」。

---

## 3. 模块级审查总览

| 模块 | 正确性 | 健壮性 | 稳定性 | 风险等级 | 是否建议修改 |
| --- | --- | --- | --- | --- | --- |
| 1. App 基础架构 / 启动 | ⚠️ 中 | ❌ 低 | ⚠️ 中 | **高** | 建议收口前修 |
| 2. 日志 / 记录 / 编辑器 | ⚠️ 中 | ⚠️ 中 | ⚠️ 中 | 中高 | 建议收口前修 |
| 3. 知识块 / 折叠块 | ✅ 高 | ✅ 高 | ✅ 高 | 低 | 可延后 |
| 4. 复习系统 / FSRS | ✅ 高 | ⚠️ 中 | ✅ 高 | 中 | 部分建议修 |
| 5. 复习 UI / 状态机 | ✅ 高 | ⚠️ 中 | ✅ 高 | 中 | 可延后 |
| 6. AI 能力 / Cockpit | ⚠️ 中 | ⚠️ 中 | ⚠️ 中 | 中高 | 建议收口前修 |
| 7. Learning Coach | ⚠️ 中 | ⚠️ 中 | ⚠️ 中 | 中高 | 建议收口前修 |
| 8. 语音复述 / Voice Tutor | ⚠️ 中 | ⚠️ 中 | ⚠️ 中 | 中高 | 部分建议修 |
| 9. 设置 / Provider 配置 | ❌ 低 | ⚠️ 中 | ⚠️ 中 | **高** | 建议收口前修 |
| 10. 搜索 / OCR / 索引 | ⚠️ 中 | ⚠️ 中 | ⚠️ 中 | 中 | 部分建议修 |
| 11. 统计 / 数据分析 | ⚠️ 中 | ✅ 高 | ✅ 高 | 中 | 可延后 |
| 12. 通知 / Error / Feedback | ❌ 低 | ❌ 低 | ⚠️ 中 | **高** | 建议收口前修 |
| 13. UI/UX 交互稳定性 | ⚠️ 中 | ⚠️ 中 | ✅ 高 | 中 | 部分建议修 |
| 14. Android 平台 | ⚠️ 中 | ⚠️ 中 | ⚠️ 中 | 中高 | 建议核实 |
| 15. Desktop / Electron | ⚠️ 中 | ⚠️ 中 | ⚠️ 中 | 中高 | 建议收口前修 |
| 16. 数据持久化 / 迁移 | ✅ 高 | ✅ 高 | ✅ 高 | 低 | 可延后 |
| 17. 性能 / 资源 | ⚠️ 中 | ⚠️ 中 | ✅ 高 | 中 | 可延后 |
| 18. 构建 / 测试 / 工程质量 | ⚠️ 中 | ⚠️ 中 | ⚠️ 中 | 中高 | 建议收口前修 |
| （附）ZIP 导出 / 备份链路 | ❌ 低 | ❌ 低 | ❌ 低 | **极高** | **必须修** |

图例：✅ 正常 ／ ⚠️ 有缺口 ／ ❌ 存在明确缺陷

---

## 4. 模块详细报告

### 4.1 App 基础架构 / 启动 / 全局状态

**当前状态**：能正常启动和运行，导航与返回键处理（`App.tsx:738-784`）设计得相当细致（沉浸式会话返回、tab 深度栈、双击退出）。但**缺少一切异常兜底**。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| A-1 | 确认 Bug | **完全没有 ErrorBoundary 与全局异常处理**。全仓库零 `ErrorBoundary` / `componentDidCatch` / `getDerivedStateFromError` / `window.onerror` / `unhandledrejection`。任一子组件渲染抛错 → 整页白屏，无恢复路径，用户只能强杀重启。 | `src/main.tsx:68` 直接 `<App/>`；全 src grep 无匹配 |
| A-2 | 确认 Bug | **启动初始化链无 try/catch，单点失败导致永久无法进入应用**。`storage.initialize()` → `recoverKnowledgePodcastJobs()` → `rebuildProjections()` → `refreshDueVerifications()` 任一抛错，`setInitialized(true)` 永不执行，App 永久停在未初始化态（白屏或 loading）。 | `src/hooks/useAppData.ts:182-208`，失败点在 189 / 190，`setInitialized(true)` 在 193 |
| A-3 | 健壮性 | **StrictMode 双挂载触发两次完整初始化链**，cleanup 只置 `mounted=false`，不 abort 进行中的 Promise。第二次挂载会重复执行 `flushAutoBackupNow("app-start")` 等有副作用的操作。 | `useAppData.ts:205-207`（cleanup 仅 `mounted=false`）；`main.tsx:69` 用 `StrictMode` |
| A-4 | 架构 | `App.tsx` 1821 行 / 77 KB 单一巨型组件，同时持有导航、tabs 记忆、reviewRuntime、visualTheme、4 个 toast、键盘状态、desktop 迁移弹窗等全部全局状态（`App.tsx:142-272`），并向 `ReviewPage` 注入 55 个 props。 | `App.tsx:251-272`、`App.tsx:1544-1660` |
| A-5 | 架构 | `useAppData` 返回约 80 个方法与 20 个状态数组（`useAppData.ts:1002-1086`），以单一 `app` 对象广播给所有页面 → 「谁都能改」，耦合面极大。 | `useAppData.ts:1002-1086` |
| A-6 | 健壮性 | App 根缺少 background→foreground 的恢复逻辑（只在 `visibilitychange` 时 abort 解释任务，未重建 due/会话状态）。后台返回后可能停在停滞状态。 | `useAppData.ts:216/992`；`PlaybackProvider.tsx:114` |
| A-7 | 技术债 | `reviewRuntime`（评分撤销运行时状态）由 App 持有并跨页透传，仅靠「约定」保证不进入同步/备份，没有类型或运行时约束。 | `App.tsx:264`、`App.tsx:1623-1624` |

**潜在风险**：`A-1` + `A-3` 组合下，一次初始化竞态就可能造成「偶发白屏，重启后自愈」，难以复现也难以定位。

**推荐处理**：**P0** — 加根级 ErrorBoundary + `window.onerror`/`unhandledrejection` 桥接到 `uiError`；给初始化链加 try/catch 并把失败态渲染成可操作页面（重试按钮）。这两项都是局部新增，不动既有结构。

---

### 4.2 日志 / 记录核心 / 编辑器

**当前状态**：主路径可用，保存有事务保证，草稿有独立存储。但并发编辑与卸载落库存在缺口。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| B-1 | 高风险 | **多 tab / 多入口并发编辑无任何冲突检测**。`saveBlock` 只用 `deepEqualIgnoring(existingBlock, normalized, ["updatedAt"])` 判断「未变化」，没有 revision/etag/乐观锁。两个 tab 同时保存同一记录 → 后写静默覆盖先写，无提示。草稿表以 `id=recordId` 共享，也会互相覆盖。 | `storageAdapter.ts:872-938`；`RecordEditorPage.tsx:404`（`storedDraft.updatedAt > record.updatedAt` 判断可能让已提交改动被旧草稿回滚） |
| B-2 | 健壮性 | **页面卸载 / 隐藏时的草稿 flush 不被 await**，IndexedDB 异步写在页面被销毁时可能丢失。`void flushDraft().catch(()=>undefined)` + 立即导航。 | `RecordEditorPage.tsx:445-464`、`637-654` |
| B-3 | 健壮性 | 草稿保存失败被静默吞掉：`setDraftSaveStatus("error")` 后 `throw`，但唯一的调用方是 `void flushDraft(...).catch(()=>undefined)`，用户会误以为草稿已保存。 | `RecordEditorPage.tsx:296-299` + `445-464` |
| B-4 | 健壮性 | **OCR 重试任务可能永久卡在 `queued`**。重试挂在内存定时器（10s–300s），若 App 在等待期被杀，资产保持 `ocrStatus:"queued"` 且 `ocrUpdatedAt` 很新 → `resetStaleOcrJobs` 的 10 分钟阈值不会命中，启动时也没有按 `queued` 重排队 → UI 永久显示「等待重试」。 | `ocrJobService.ts:133-152`；`storageAdapter.ts:1717-1742` |

**潜在风险**：`B-1` 在单用户单设备上不触发，但项目已实现 tab 导航 + 桌面多窗口 + 云同步多设备恢复，一旦跨设备/跨窗口就会命中。

**推荐处理**：`B-1` **P1**（草稿已带 `baseUpdatedAt` 字段可复用，`storageAdapter.ts:289` 只是没用）；`B-2`/`B-3` **P2**；`B-4` **P2**。

---

### 4.3 知识块 / 折叠块 / 学习内容结构

**当前状态**：**本模块是全项目质量最高的部分之一。**

**已确认问题**：无确认 Bug。

**正面复核结论**

- 折叠块用 Tiptap `content:"block+"` 承载子内容（`RecordStructureNodes.tsx:956-994`），删除父节点即整棵移除，**不会产生孤儿子块**（`RecordEditorNodes.tsx:66-72` 按 `node.nodeSize` 删除）。
- 空折叠块在 Tiptap 约束下会保留一个空 paragraph，**不会把无内容块泄漏到正文**。
- `syncRecordRefsFromContent`（`recordContent.ts:118`）只重算 asset/formula，decision-block 的解析走独立路径 `prepareDecisionBlockContentForSave`，解析不完整只会「少提取重点」，不抛错、不阻断保存。

**潜在风险**：decision-block 解析失败**没有任何可观测信号**（既不抛错也不记日志）。未来若要排查「为什么这条记录没被抽出复习重点」会很困难。

**推荐处理**：**P3**（仅记录技术债；若后续要动，加一行结构化日志即可）。

---

### 4.4 复习系统 / FSRS

**当前状态**：**FSRS 调用经复核是正确的**，这是本模块最重要的结论。

**正面复核结论（明确回答了「FSRS 调用本身是否正确」）**

| 维度 | 结论 | 证据 |
| --- | --- | --- |
| 算法实现 | ✅ 正确 | 使用 `ts-fsrs@5.4.1` 的 `fsrsScheduler.next(card, now, grade)`，参数顺序与 v5 契约一致 |
| 参数传递 | ✅ 正确 | `forgot→Again(1) / fuzzy→Hard(2) / good→Good(3) / easy→Easy(4)`，与 `Rating` 枚举完全对齐 |
| 状态迁移 | ✅ 正确 | 通过 `next` 内部的 State 机完成，无字段错配 |
| 业务规则 | ⚠️ 有意为之 | `enable_short_term:false` + 空 learning/relearning steps（`reviewScheduler.ts:38-45`）——刻意禁用短期学习步骤，让新卡首评直接落到 FSRS 间隔。这是**业务决策**，不是 bug |
| 撤销链路 | ✅ 稳健 | 撤销前校验 `latestLog` 才执行，写 `rating-undone` 并还原 `previousFsrsCard` 全字段，测试覆盖同日纠正撤销与 day-stat 还原（`storageAdapter.ts:1309-1360`、`:247`） |
| 事务原子性 | ✅ 良好 | 评分在单事务内完成（`storageAdapter.ts:1138-1266`），失败整体回滚，UI 乐观更新有 catch 回滚（`ReviewPage.tsx:706-719`） |

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| C-1 | 健壮性 | **投影重建对「缺少 `stateAfter` 的旧日志」处理不一致**：重建时按 `stateAfter` 存在与否过滤（`:544`），但日统计重算用另一组过滤（`:560-572`）→ 可能出现 `recordReviews` 与日统计不一致。 | `storageAdapter.ts:541-557`、`:544`、`:560-572` |
| C-2 | 健壮性 | **时区双轨存储脆弱**。`nowISO()` 存 UTC，`reviewedDate/lastReviewDate` 存**设备本地日**，`dateForISO` 取本地午夜。测试已经依赖 TZ≥UTC+8（`storageAdapter.review.test.ts:385` 期望 `2026-07-02T16:30Z` → `lastReviewDate="2026-07-03"`），在 UTC 环境下会错位。跨时区设备 + 云合并时「今天」的边界可能不一致。 | `lib/date.ts:18`、`:22`；`reviewScheduler.ts:47`、`:254` |
| C-3 | 健壮性 | **同日重评（Again）的 `elapsed_days=0`** → FSRS 不触发 lapse / Relearning 惩罚，语义上退化为「纠错」而非「遗忘」。这是**数据模型/业务规则问题**：想标记「今天忘了」在模型上没有出口。 | `reviewScheduler.ts:254-257`、`:280`；`storageAdapter.ts:1147-1156` |
| C-4 | 架构 | **无显式幂等键**（`recordId+reviewedAt+rating+opId`）。防重依赖 Dexie 事务串行化 + 同日 correction 分支，单设备单标签页可靠，但跨日/跨标签/云重放场景理论上可产生两条评分 → 双倍计数。 | `ReviewPage.tsx:645` 单飞标志；`storageAdapter.ts:1147` |
| C-5 | 技术债 | 切换 `reviewKind` 会重置 repetition/intervalDays 并重建 fsrsCard（`storageAdapter.ts:1059` → `:442`），**丢弃 FSRS 记忆连续性**。属业务规则决策，但没在 UI 上告诉用户。 | `storageAdapter.ts:1059`、`:442` |

**推荐处理**：`C-1`/`C-2` **P2**（必须配 TZ 固定的测试）；`C-3` **P3**（建议仅在文档中明确语义，不要改算法）；`C-4` **P2**（若未来加云重放则升为 P1）；`C-5` **P3**。

---

### 4.5 复习 UI / 复习流程状态机

**当前状态**：状态机基本正确，空队列、跨日、刷新后的重置都有处理。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| D-1 | 健壮性 | 会话进度（本 session 已评列表）**不持久化**，刷新后已评卡片会重新出现。虽被同日 correction 保护住不会双倍计数，但用户体验上会显示「重复的卡」。 | `ReviewPage.tsx:463/575/590-605` 重置 runtime；`storageAdapter.ts:998-1018` |
| D-2 | UX | 反复快速点击 rating 依赖 `ratingRecordId` 单飞标志与同日 correction，缺少显式的「提交中」视觉禁用反馈。 | `ReviewPage.tsx:645` |

**推荐处理**：**P3**。

---

### 4.6 AI 能力 / AI Cockpit

**当前状态**：上下文组装质量不错（经复核**没有重复注入**，且**正确排除了已删除记录**），但生成侧有几个明确缺陷。

**正面复核结论**

- `getAiKnowledgeScopeRecords` 正确过滤 `!block.deletedAt`（`aiContextService.ts:227`），retrieval 不会取到已删记录。
- 音频/附件类附件被正确标记 skip，不计入上下文（`:527`）。
- 覆盖模式下按 `chunkId` 去重（`:377`）→ **确认无同一内容双注入**。
- `buildAiMessages` 只有单一 attachment 来源（`:225`）。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| E-1 | 确认 Bug | **`max_tokens` 截断被静默忽略**。捕获了 `finish_reason` 但从不判定 `length`；截断后 content 为半截，走到结构化输出时 `JSON.parse` 直接抛 `AiSchemaError`，且该错误标记为**不可重试**。 | `aiClientService.ts:315`；`aiGateway.ts:27/33`；`quizExecutionGateway.ts:51/67`（上限 1800/1000/900，含 3 个 blueprint 时易超限） |
| E-2 | 确认 Bug | **内置 provider 默认值疑似无效**。DeepSeek 默认 `model: "deepseek-v4-pro"`（`aiProviders.ts:26`）；`custom-proxy` 默认 `baseUrl: "https://api.vectorengine.ai"` 且 `model: ""`（`:53`）；TTS 的 tencent/google 默认 `model: ""`。种子默认值**不经过校验即入库**（校验只在 `AiSettingsPanel.tsx:153-158` 保存时触发）→ 开箱即用请求容易 400/404。**注：`deepseek-v4-pro` 是否真实存在，本环境无法联网核实，请人工确认。** | `aiProviders.ts:26/53`；`ttsProviders.ts:27/36` |
| E-3 | 高风险 | **并发串台 / 双提交**。`busy` 来自闭包，提交前不重渲染可双触发；切换会话只调 `refresh()`，**abort 仅在组件卸载时**发生（`AiChatPage.tsx:184`）→ 旧请求结果用旧会话闭包 `setMessages([...visibleHistory, assistant])` 短暂覆盖新会话 UI。 | `AiChatPage.tsx:421`、`:214`、`:184`、`:533/546` |
| E-4 | 健壮性 | **provider 能力未协商**：始终发送 `response_format:{type:"json_object"}` + `thinking` + `reasoning_effort`（`aiClientService.ts:387-389`），部分供应商不支持；原生路径错误形态另做映射（`:354-361`）。 | `aiClientService.ts:387-389`、`:354-361` |
| E-5 | 健壮性 | token 上限只有本地启发式估算（中文 ×1.5），无服务端真实 usage 回退；`MAX_INDEXED_CONTEXT_CHARS = 1e6`。中文密度高或窗口小时仍可能超窗。 | `aiContextService.ts:139`、`:23`、`:193` |
| E-6 | 健壮性 | **成功结果因写库失败而丢失**：`await storage.saveAiMessage?.(assistantMessage)` 若抛错则落入 catch，只保存错误消息，模型正文被丢弃。 | `AiChatPage.tsx:528`、`:535` |
| E-7 | 技术债 | `recharts` 同时出现在 `manualChunks.charts` 与主包路径中（`vite.config.ts`），需确认是否真的按预期分块。 | `vite.config.ts:rollupOptions` |

**推荐处理**：`E-1`/`E-3` **P1**；`E-2` **P1**（先人工核实模型名，然后要么改默认值要么加校验）；`E-4`/`E-5`/`E-6` **P2**。

---

### 4.7 Learning Coach

**当前状态**：设计意图清晰（事实表 + 投影表分离，投影可从事件重算），replay 是纯函数且不重复计分。但重试路径与「建议入正式库」的边界有问题。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| F-1 | 确认 Bug | **分析批次崩溃后不可重试，永久卡死**。`persistAnalysisCandidate` 已把蓝图/任务写入库，但 subBatch 尚未置 `succeeded`；重试时顶部 `existingSnapshot` 已含该 `accepted` 蓝图，循环再次 persist 同一 `idempotencyKey` 但不同 `id` → `ensureIdempotentInsert` 抛 `duplicate-event`。**根因：重试未复用已落库实体的 id。** | `orchestrator.ts:506-510`、`:584-629`、`:514-525`、`:452-455`；`repository.ts:864`、`:113-120` |
| F-2 | 高风险 | **AI 生成的蓝图/任务在用户逐项审阅前就写入正式库**。`acceptBlueprint("accepted")` + `createTask("waiting")` 直接落库，而 `sessionBlueprints`/`adaptiveReviewTasks` **属于跨端同步的正式实体**。「分析前一次性确认」被当作对蓝图内容的人类确认。这与 `AGENTS.md` 声明的边界（AI 建议需用户确认）存在张力。 | `orchestrator.ts:449-450`、`:507`、`:584-629` |
| F-3 | 健壮性 | **in-progress 任务无超时/自动放弃**。状态机无自动出边，`selectNextTask` 遇 in-progress 即返回 → 用户中途离开后任务永久 in-progress，且该块的延迟验证因 `openTargets` 含 in-progress 而永不排队。 | `stateMachines.ts:63-74`；`orchestrator.ts:885-899`、`:908-914` |
| F-4 | 架构 | **投影一致性靠「变更后全表 clear + bulkPut 重算」**，而不是事件驱动；`addQuizTurn` / `recordQuizHint` 不触发重建。高频复习下有性能与遗漏风险。 | `repository.ts:411-433`、`:994`、`:1028` |
| F-5 | 健壮性 | replay 本身安全，但**引用不校验**：`generateQuizTurn`/`submitQuizAnswer` 不重查 `blueprint.feedbackIds` 是否已被软删 → 蓝图可指向已删反馈。 | `replay.ts:62-149`；`repository.ts:427-433` |
| F-6 | UX | `recordFeedback` 的幂等键是 `feedback:${operationId}`，两次点击若 operationId 不同可写两条 feedback。 | `orchestrator.ts:241` |

**推荐处理**：`F-1`/`F-2` **P1**（`F-2` 涉及数据边界与同步白名单，建议先与你确认产品意图再动）；`F-3` **P1**（影响可用性）；`F-4`/`F-5`/`F-6` **P2/P3**。

---

### 4.8 语音复述 / Voice Tutor（重点模块）

**当前状态**：**ASR → LLM → TTS → 下一轮监听 的闭环经复核是完整成立的**（这是本模块最关键的结论），麦克风互斥在原生层双向强制。问题集中在状态污染与配置双源。

**正面复核结论**

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 闭环完整性 | ✅ 成立 | `SUBMIT_CAPTURE→finalizing-asr`(489) → `ASR_FINALIZED→thinking`(682) → `respondTurn`(701) → `LLM_REPLIED→speaking`(714) → `PLAYBACK_FINISHED→listening`(731) → auto-listen effect 重启采集(857-861)。**无「ASR 成功但跳过 LLM」或「LLM 成功但跳过 TTS」的静默分支**：空正文抛错(`pipeline.ts:226`)、TTS 失败抛错(`:230`)，都是明确回退 |
| 麦克风互斥 | ✅ 原生层双向强制 | `VoiceCaptureController.java:63` 采集前 `if(AudioRecordingController.isRecording()) throw`；`AudioRecordingController.java:30` 录音前 `if(VoiceCaptureController.isCapturing()) throw` |
| TTS 播放期误触发 VAD | ✅ 状态层已防 | speaking 时 `systemCaptureGate=true`，auto-listen 要求 `!systemCaptureGate`(857) → 播放期间不采集 |
| 会话结束后的回调 | ✅ 基本可控 | `cancelActiveTurn` 用 `operationEpoch++` + cancellation tree 中止 ASR/LLM/TTS(`runtimeController.ts:42`)，卸载时 `disposeView→pause`(305) |

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| G-1 | 健壮性 | **上一轮 token 会污染下一轮草稿**。`onTeacherToken` 里 `setTeacherDraft((draft) => draft + token)` **没有** `isCurrentOperation/generation` 守卫（对比采集侧 `:444` 已守卫）。cancel 后若残流 token 到达，会追加到新轮次的 `teacherDraft`。 | `VoiceRecallWorkspace.tsx:711-717`（对比 `:444`） |
| G-2 | 技术债 | generation 门控部分失效：`onAudio` 透传的 `generation` 在 `enqueueAudio` 被忽略，管线内计算的 generation 沦为死值，实际只靠 `interruptPlayback` 自增。 | `runtimeController.ts:203`；`VoiceRecallWorkspace.tsx:718` |
| G-3 | 架构 | **配置三层并存，且变更有静默丢弃**。全局 `getCurrentAiProvider/getCurrentTtsProvider`（fallback）＋ 模板 `asrProfileId/.../ttsProfileId` ＋ 可编辑 config 逐段 override，由 `productionPipeline.ts:140-141,146` 决定优先级。`overridesFromConfig` 在 `config.templateId !== templateId` 时**静默返回 undefined** → stale localStorage 下逐段 override 被无声丢弃，用户无任何提示。 | `productionPipeline.ts:70-71`、`:140-146` |
| G-4 | 文档不一致 | **barge-in 的文档与实现矛盾**。`INTERRUPT_AND_LISTEN`（speaking→listening）已实现，且「打断回复」按钮实际 dispatch 它；但 `docs/voice-recall-freeze-*` 声明「barge-in 未实现」。该项也**未做真机验收**。 | `domain.ts:158`；`VoiceRecallWorkspace.tsx:958-964` |
| G-5 | 健壮性 | 原生回声消除 / 音频焦点 / 来电中断**未做真机验收**，仅靠状态门控（属已声明的开放门槛）。 | `docs/voice-recall-freeze-2026-09-11.md` |
| G-6 | 技术债 | `?preview=voice-recall-policy` 复用真实 `VoiceRecallWorkspace` + Mock 适配器，与真实会话**共用同一个 Workspace 组件**，只靠 URL 主机校验区分。 | `App.tsx:1538`；`stage3PreviewSeed` 同源守卫 |

**VR-\* 诊断编号产生点（专项追踪结果）**

- 前缀映射由 `uiError.ts:33-37` 的 `diagnosticPrefix` 决定：取 context 各段首字母拼接前 3 位 → `voice-recall → VR`。
- **全部产生点**：`productionPipeline.ts:43`（`describeVoiceError`）、`VoiceRecallWorkspace.tsx:241/302/359/458/464/531/625/773/799`、`VoiceAsrCredentialSettings.tsx:26/38`。
- 注意：`VoiceConfigurationError` / `VoiceStageError` **自带可读文案、不产出 VR-**（走 `formatActionableError`）。
- 完整前缀表：`voice-recall→VR`、`review-rating→RR`、`review-undo→RU`、`review-feedback→RF`、`review-annotation→RA`、`adaptive-review→AR`、`record-save→RS`、`ai-request→AI`、`cloud-sync→CS`、`generic→G`。

**推荐处理**：`G-1` **P1**（一行守卫）；`G-3` **P1**（配置源统一，与本报告 §4.9 合并处理）；`G-4` **P1**（先修文档或先补真机验收，二者必须一致）；`G-2`/`G-5`/`G-6` **P2/P3**。

---

### 4.9 设置 / Provider / API 配置中心（本报告最重的架构问题）

**当前状态**：❌ **项目确实存在多套互相独立的配置系统，没有单一事实源。**

**配置来源全量枚举**

| 存储位置 | 内容 | 读取方 | 是否 source of truth |
| --- | --- | --- | --- |
| Dexie `settings` 表 → `settings.ai` | AI provider 参数（`types.ts:351`） | AiSettingsPanel、AiChatPage、useAppData、podcast 服务 | ✅ 是（AI 参数） |
| Dexie `settings` 表 → `settings.tts` | TTS provider 参数（`types.ts:452`） | TtsSettingsPanel、语音复述 | ⚠️ **仅部分生效** |
| Dexie `aiSecrets` 表（**明文**） | AI / TTS / ASR / OCR 四类密钥共用同一张表 | 上面全部 + `credentials.ts:7` + `ocrSettings.ts:3` | ✅ 是（密钥） |
| `localStorage["study-journal.voice-recall.config"]` | `VoiceProviderEditableConfig`（asrEndpoint / llmModel / ttsEndpoint / ttsModel，自由文本） | `productionPipeline.ts:133-175`、VoiceRecallWorkspace | ❌ **否 —— 覆盖层，与 Dexie 分叉** |
| `localStorage["study-journal.voice-recall.template"]` | 选中的模板 id | 同上 | ❌ 否 |
| 内置常量 `BUILT_IN_ASR_PROFILES` / `BUILT_IN_VOICE_TTS_PROFILES` / `BUILT_IN_VOICE_TEMPLATES` | 默认模板 | `resolveVoiceProviderTemplate` | 默认值（部分孤儿） |
| `preview/stage3PreviewSeed.ts:414` 写入的 `aiSecrets["default"] = "stage9-preview-placeholder"` | 占位密钥 | 无 | ❌ 应废弃（污染 default 槽） |

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| H-1 | 架构（**最高优先级**） | **配置双源分裂且互不回写**。`productionPipeline.ts:140-146` 优先用 localStorage 的 `config.*`，否则回退 Dexie。但 `ttsEndpoint/ttsModel/ttsVoice` 是自由文本（`VoiceProviderSettings.tsx:48-51` 写入），**永远不从 `settings.tts` 同步**。→ 用户在 TtsSettingsPanel 改了模型，语音复述仍用旧的 localStorage 值。 | `productionPipeline.ts:140-146`；`VoiceProviderSettings.tsx:48-51` |
| H-2 | 高风险 | **API Key 明文落库**。`saveAiSecret` 直接 `db.aiSecrets.put({apiKey})`，无任何加密。AI / TTS / ASR SecretId+Key / OCR token 全部明文共存一表。 | `storageAdapter.ts:2305-2321`；`types.ts:358` |
| H-3 | 高风险 | **`android:allowBackup="true"` 与「纯本地、离线优先」的产品承诺矛盾**。Android Auto Backup 会把应用数据目录（含 IndexedDB 学习数据 + **明文 API Key**）同步到用户的 Google Drive，且仓库内没有 `android:fullBackupContent` / `dataExtractionRules` 排除规则。这是**可离线带走的密钥副本**。 | `AndroidManifest.xml:5`；无 `res/xml/backup_rules.xml` |
| H-4 | 技术债 | 默认值含无效占位（同 E-2），且**种子默认值不经校验即入库**。 | `aiProviders.ts:26/53`；`AiSettingsPanel.tsx:153-158` |
| H-5 | 技术债 | 模板里的 `llmProfileId:"deepseek-v4-flash"`（`providerProfiles.ts:261`）与实际种子 id `"default"`（`aiProviders.ts:60`）不匹配，靠 `productionPipeline.ts:147` 覆盖才不报错 → 该常量是死值。 | `providerProfiles.ts:261`；`aiProviders.ts:60` |
| H-6 | 架构 | **「会话快照」存在但无一致性协议**。`productionPipeline.ts:200` 的 `configurationIdentity` 在会话创建时固化配置，运行期不回读全局设置（设计如此），但 localStorage 覆盖层与 Dexie 之间**不互相校验**，也不告诉用户「你正在用旧配置」。 | `productionPipeline.ts:200` |

**修改某套配置会影响哪些模块**

```
修改 Dexie settings.ai / settings.tts（"正统" source of truth）
 ├─ AI Chat / AI Tools / AI Export / AI 诊断
 ├─ Learning Coach（全部 AI 网关）
 ├─ 知识播客（脚本 + TTS）
 ├─ 语音复述的 LLM 腿与 TTS 腿（仅在 localStorage 无 override 时生效！）
 └─ OCR 设置页

修改 localStorage voice-recall.config（"影子"覆盖层）
 └─ 只影响语音复述的三条腿，且与上面完全隔离
     └─ 后果：设置页显示的值与语音复述实际使用的值可以永久不一致

修改 aiSecrets（密钥）
 └─ AI / TTS / ASR / OCR 全部同时受影响（四类密钥共用一张表）
```

**推荐处理**：`H-1` **P0/P1（收口前必须决策）**——建议统一到 Dexie `settings` 作为唯一 source of truth，把 localStorage 降级为纯 UI 偏好；或至少让 `templateId` 不匹配时**显式报错**而不是静默丢弃。`H-2` **P1**；`H-3` **P0**（一行 Manifest 改动，收益极高）；`H-4`~`H-6` **P2/P3**。

---

### 4.10 搜索 / OCR / 本地索引

**当前状态**：功能可用，主要缺口在索引策略与 OCR 任务生命周期。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| I-1 | 架构 | **全文搜索为全表线性扫描，无索引**。每次查询遍历全部 entries + blocks + assets 做 `normalize().includes()`；只有 256 条文本缓存，且缓存键基于 `updatedAt`。万级记录下是 O(N·M)。 | `search.ts:104-255`、`:7`、`:15`、`:24` |
| I-2 | 健壮性 | OCR 重试可能永久卡 `queued`（同 B-4）。 | `ocrJobService.ts:133-152` |

**已复核否定的结论（重要）**

> 曾有分析认为「已删除记录仍会出现在搜索结果中」。**该结论经复核为不成立。**
> 理由：`SearchPage` 接收的 `blocks` 来自 `useAppData` 的 `blocks` 状态，而该状态由 `storage.listBlocks()` 提供，而 `listBlocks()` 已经过滤了 `!block.deletedAt`（`storageAdapter.ts:866-868`；`useAppData.ts:89/104`）。输入侧已完成过滤。
> 残留建议（非缺陷）：`searchAll` 本身不做 `deletedAt` 防御，`searchRecordTitlesAsync:279` 却做了 → **防御策略不一致**，属技术债。`aiContextService.ts:227` 也有过滤 → 三处一致性靠约定而非类型。

**推荐处理**：`I-1` **P2**（若记录量已达千级，建议至少给标题加 Dexie 索引）；`I-2` **P2**。

---

### 4.11 统计 / 数据分析

**当前状态**：除零/NaN 在聚合层已有保护，展示层有个别脆弱点。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| J-1 | 架构 | **统计与事实数据不同源**：`deriveLearningStats` 聚合的是 `RecordReviewStats`（复习调度器产物），与 journal blocks 解耦 → 删除某条记录后，其 `dueCount/overdue/streak` 仍被计入，形成「幽灵复习量」。 | `StatsPage.tsx:41`；`learningStats.ts:51` |
| J-2 | 健壮性 | 趋势条的 `width: Math.round(rememberedRate * 100)%` 未防 `rememberedRate` 为 undefined/NaN。 | `StatsPage.tsx:92` |

**正面复核结论**：`learningStats.ts:33`（`sampleSize===0` 返回 null）、`:64`（`dueAtFirstOpen>0 ? ... : null`）、`StatsPage.tsx:34`（仅 `rate!==null` 时显示百分比）—— 除零保护到位。

**推荐处理**：`J-1` **P2**；`J-2` **P3**。

---

### 4.12 通知 / Toast / Error / Feedback

**当前状态**：❌ **本模块是「ZIP 导出之谜」的直接原因，也是全项目可靠性最薄弱的一环。**

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| K-1 | **确认 Bug（高影响）** | **`normalizeUiError` 主动丢弃错误对象**。形参名就是 `_error`，既不出现在界面、也不写 `console`、不落盘、不上报。→ 完整性校验失败、磁盘写满、权限被拒、分享面板拒绝、OOM **全部**渲染成同一句「操作没有完成，请稍后重试。（诊断编号 G-xxxxxxxx）」，而该编号**没有任何可查询的记录**。 | `uiError.ts:39-47`，配合 `BackupPage.tsx:103` 的 `formatUiError(error, "generic")` |
| K-2 | 确认 Bug（同源） | 全项目 **58 处 `.catch(() => undefined)`** 静默吞错 + **358 处 `void`** fire-and-forget；失败既无 UI 反馈也无日志。 | 静态扫描结果（§1.6） |
| K-3 | 架构 | 无 ErrorBoundary 承接渲染异常，`uiError.ts` 的设计意图（所有渲染错误经它格式化）**无法落地**。 | 同 A-1；`AGENTS.md` 第 12 行的约定与实现脱节 |

**诊断编号格式（已解码，工具性知识）**

`<prefix>-<time><sequence>`

- `prefix` = context 各段首字母大写拼接取前 3 位（`generic→G`）
- `time` = `Date.now().toString(36).slice(-5).toUpperCase()`，每 **36⁵ ms ≈ 16.8 小时**循环一次
- `sequence` = 模块内自增计数器（1..46656）base36 补零 3 位 → **`001` 表示该 App 会话的第一条 UI 错误**
- 例：`G-8ZEJU001` → `15088746` → 候选时刻 `2026-09-13 11:21:42 (GMT+8)`

**推荐处理**：`K-1` **P0**（一行 `console.error` 即可让此后所有失败可定位，界面文案与隐私约定完全不变）；`K-2` **P2**（分批把吞错改成有日志的兜底）；`K-3` **P0**（与 A-1 同一改动）。

---

### 4.13 UI/UX 交互稳定性

**当前状态**：整体稳定；实测未发现「点击无反馈」「重复执行」「overlay 残留」的硬缺陷。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| L-1 | UX | 编辑器在窄屏有紧凑工具条（已按 `2026-09-12` 提交声明做过），但 `App.tsx` 的键盘检测逻辑（`keyboardVisible`）与 `visualViewport` 监听较为复杂，跨 Android 版本行为未自动化验证。 | `App.tsx:142-204` |
| L-2 | UX | 评分撤回（undo）历史属于 App 级 runtime，App 进程内跨 tab 有效，**但不持久化**。用户刷新后无法撤回 → 与「撤回」的心理预期有落差。 | `App.tsx:264`；`AGENTS.md` 相关段落 |

**已复核否定的结论（重要）**

> 曾有分析认为「`ImageLightbox` 未拦截返回键，会导致全局返回导航同时触发」。
> **经复核为不成立。** `App.tsx:739` 在检测到 `.image-lightbox` 时**主动 return 不处理**，而 `ImageLightbox.tsx:203-217` 自身注册了 `backButton` 监听并执行 `closePreservingScroll()`。两者协作正确：App 礼让、灯箱关闭。

**推荐处理**：`L-1` **P3**；`L-2` **P3**（建议在 UI 上明确「撤回仅在本次使用期间有效」）。

---

### 4.14 Android 平台

**当前状态**：权限、返回键、键盘（`adjustResize`）、摄像头/麦克风权限引导都处理正确。但**在 targetSdk 36 下的 insets 策略存在实质风险**。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| M-1 | **高风险** | **targetSdk = 36，且 `setDecorFitsSystemWindows(window, true)`**。自 Android 15（SDK 35）起，edge-to-edge 对 targetSdk≥35 的应用**强制生效**，`setDecorFitsSystemWindows(true)` 被框架忽略；同时 `Window.setStatusBarColor` / `setNavigationBarColor`（API 35 起废弃）**同样失效**。→ 状态栏/导航栏实际会透明并覆盖内容，而 Web 侧 `env(safe-area-inset-*)` 的大量使用（`voiceRecallPresentation.css`、`uiV2Prototype.css` 等十余处）与「内容已被系统栏 inset」的假设**互为矛盾**。存在状态栏图标压在内容上、或底部控件被手势条遮挡的真实风险。 | `android/variables.gradle` targetSdk 36；`MainActivity.java:23-28`；`env(safe-area-inset-*)` 十余处 |
| M-2 | 健壮性 | 无 `values-night` 资源，但 `AppTheme.NoActionBar` 继承 `Theme.AppCompat.DayNight.NoActionBar` → 系统深色模式下原生窗口底色与 App 的「reading」浅色主题可能短暂不一致（启动闪白/闪暗）。 | `res/values/styles.xml`；`res/` 下无 `values-night/` |
| M-3 | 健壮性 | `MainActivity` 无 `onSaveInstanceState`，低内存被杀后 WebView 重载（靠 IndexedDB 恢复数据，但内存态 session 丢失）。 | `MainActivity.java` |
| M-4 | 健壮性 | `allowBackup="true"` 无排除规则（同 H-3）。 | `AndroidManifest.xml:5` |
| M-5 | 技术债 | `minifyEnabled false` → release 包无代码压缩/混淆，包体偏大；虽有 `proguard-rules.pro` 但未启用。 | `android/app/build.gradle:39` |

**正面复核结论**：`configChanges` 覆盖 orientation/screenSize/keyboard/density 等（`AndroidManifest.xml:13`），有效避免旋转重建；`RecordingForegroundService` / `MediaPlaybackService` 的 `foregroundServiceType` 声明正确；`MediaPlaybackService` 设 `stopWithTask="false"` 保证后台播放不被任务切换杀掉；FileProvider `authorities` 为 `${applicationId}.fileprovider` 且 `file_paths.xml` 的 `cache-path path="."` 覆盖 `shared-exports`。

**推荐处理**：`M-1` **P0（需真机核实后决定）**——建议要么显式启用 edge-to-edge 并统一由 `env(safe-area-inset-*)` 负责留白，要么回退 `targetSdk 34`；两者必须选一个，不能维持现状的假设冲突。`M-2` **P2**；`M-3` **P3**；`M-4` **P0**（同 H-3）；`M-5` **P3**。

---

### 4.15 Desktop / Electron

**当前状态**：安全隔离与 asar 路径处理**正确**（这部分做得很好），但存在硬编码本机路径。

**正面复核结论**

- 路径解析正确：`DIST_ROOT = path.resolve(__dirname, "..", "dist")`，在 asar 下经自定义 `study-journal://` 协议 + `net.fetch(pathToFileURL)` 加载（`main.cjs:24/945/962`），**未使用 `file://`**，`src` 内也无 `new Worker` → **dev/prod 路径一致，不存在典型 asar 陷阱**。
- 安全配置正确：`contextIsolation:true, nodeIntegration:false, sandbox:true`（`main.cjs:997-1000`、`:1027`），preload 走 `contextBridge`。
- preload 暴露的 11 组 API 与 `src/desktop.d.ts` 声明**一一对应**，无「声明未实现」或「实现未声明」。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| N-1 | **确认 Bug** | **安装目录与数据根硬编码 D 盘**。`installer.nsh:4` `StrCpy $INSTDIR "D:\StudyJournal\App"`，`main.cjs:26` `path.resolve("D:\\StudyJournal")`、`:27` 数据根 `D:\StudyJournal\Data`。→ 没有 D 盘的机器无法安装/启动；且 `nsis.oneClick:false` + `allowToChangeInstallationDirectory:true` 的用户选择被 `preInit` **直接覆盖**。**对你本人（D 盘机器）不触发，对任何分发场景都是阻断级问题。** | `desktop/installer.nsh:4`；`desktop/main.cjs:26-27` |
| N-2 | 高风险 | **OAuth 生产配置缺失**。`main.cjs:17-22` 用 try/catch 读 `./oauth-config.cjs`，该文件被 `.gitignore:18` 忽略，仓库内只有 `.example`。缺失时 `google-sign-in` 抛「尚未配置」→ **安装包默认无法 Google 登录**。 | `main.cjs:17-22`、`:829-831`；`.gitignore` |
| N-3 | 技术债 | `scripts/android-release-build.ps1:3` 硬编码 `C:\Program Files\Java\jdk-21`；`:58-61` 把期望的 `versionCode 14` / `versionName 0.2.3` 硬编码在脚本里。→ 换机器必须改脚本；改版本号要同时改 3 处（build.gradle / 脚本 / package.json）。 | `android-release-build.ps1:3`、`:58-61` |
| N-4 | 已缓解 | `build/icon.ico` 被 `.gitignore:5` 忽略、未入库；但 `desktop:build` 会先跑 `scripts/create-desktop-icon.cjs` 从 `public/pwa-512.svg` 重新生成 → **干净 clone 仍可构建**。残留风险仅在于该脚本是 `void createIcon()` 的 fire-and-forget，失败形态不够显式。 | `.gitignore:5`；`scripts/create-desktop-icon.cjs`；`package.json:30` |

**推荐处理**：`N-1` **P1**（如确定不分发则 P2）；`N-2` **P1**（若要支持桌面云同步登录）；`N-3`/`N-4` **P3**。

---

### 4.16 数据持久化 / 数据模型

**当前状态**：**本模块是全项目最扎实的部分。**

**正面复核结论**

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| Schema 演进 | ✅ 有序 | `database.ts:120-332` 从 v1 到 v21 逐版本声明 `stores()`，含 v12–v15 的收敛跳跃与 v16→v21 的 review-coach / annotation / voice 三批新表 |
| 迁移测试 | ✅ 覆盖充分 | `database.migration.test.ts` 覆盖 v16→v17、v17→v19、v20→v21 的**成功升级**与**升级失败回滚**（`:115-166`、`:196-203`） |
| 事务边界 | ✅ 清晰 | 评分、恢复、记录转移、decision-block 导入都在单事务内完成 |
| 备份/恢复一致性 | ⚠️ 见 §4.19 | 完整性校验策略过严 |
| `settings.schemaVersion` | ✅ 有迁移链 | `defaults.ts:193` = 5，`storageAdapter.ts:644-650` 的 `migrateSettingsToDynamicSubjects` |
| 本地专用表 | ✅ 边界正确 | schema 20 `reviewAnnotationDrafts`、schema 21 `voiceRecall*` 三个 store 均为 device-local，不进入同步/备份（与 `AGENTS.md` 声明一致） |

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| O-1 | 配置 | **版本号三处不一致**：`package.json` = `0.1.6`、Android `versionName` = `0.2.3` / `versionCode` = 14、git tag = `v0.2.3`；而**备份 manifest 里的 `appVersion` 硬编码为 `"0.1.0"`**（两处）→ 任何备份都无法归属到实际产出版本，未来做恢复兼容判断时缺依据。 | `package.json:4`；`android/app/build.gradle:18-19`；`storageAdapter.ts:1941`、`:2016` |

**推荐处理**：`O-1` **P2**（建议让 manifest 的 `appVersion` 读取构建注入的版本，而非硬编码）。

---

### 4.17 性能 / 资源 / 稳定性

**当前状态**：资源清理总体严谨，但有几处体积与常驻开销问题。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| P-1 | 性能 | **主包 2,478 kB（gzip 709 kB）**，Vite 明确警告多个 chunk > 500 kB。移动端首屏解析成本高。 | 构建输出 |
| P-2 | 性能 | **PWA 预缓存 109 个文件 / ≈19 MB**，因为 `globPatterns` 覆盖所有 `js`，把 mermaid 的全部图表类型 chunk（cynefin 690 kB、mermaid.core 606 kB、cytoscape 443 kB、architecture/mindmap/sequence 等）**全部拉进 precache**。Android 首次安装需下载 19 MB，而这些图表类型绝大多数用不到（仅按需 `import()` 使用）。 | `vite.config.ts` PWA `workbox.globPatterns` + `maximumFileSizeToCacheInBytes: 3MB` |
| P-3 | 性能 | `knowledgePodcastJobService.ts:120` 每 5 秒轮询 `syncNativeKnowledgePodcastTtsJobs()`，应用生命周期内常驻。 | `knowledgePodcastJobService.ts:32/120` |
| P-4 | 健壮性 | 桌面版手动导出为**全内存**路径（`createSnapshot` + JSZip + `generateAsync("blob")`），峰值 ≈ 资源体积 ×2~3，且无体积预警或上限保护。Android 有原生流式路径，桌面/网页没有。 | `knowledgeExportService.ts:184`；`autoBackupAdapter.ts:73` |

**正面复核结论**：`setInterval` 3:3、`setTimeout` 70:67、`addEventListener` 66:63 —— **无定时器或监听器泄漏**；`setInterval` 的 4:3 先前读数包含 `ReturnType<typeof setInterval>` 类型引用的误计。

**推荐处理**：`P-1` **P2**；`P-2` **P2**（改 `globPatterns` 排除 mermaid chunk，或改用 runtimeCaching，收益高、风险低）；`P-3` **P3**；`P-4` **P1**（同 §4.19）。

---

### 4.18 构建 / 测试 / 工程质量

**当前状态**：验证链（typecheck + test + build）**全部通过**，但缺少静态检查与旁路目录的类型覆盖。

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| Q-1 | 技术债 | **完全没有 ESLint / Prettier / EditorConfig**，`package.json` 无 `lint` 脚本。在 8 万行项目里，无静态规则意味着 `no-unused-vars`、`no-floating-promises`、`react-hooks/exhaustive-deps` 类问题**无任何自动拦截**。（注：`no-floating-promises` 恰好能拦住本报告 K-2 的 358 处 `void`。） | 根目录无 `.eslintrc*` / `eslint.config.*` / `.prettierrc`；`package.json:24-43` 无 lint |
| Q-2 | 架构 | **`tsconfig` 只覆盖 `src`**（`tsconfig.app.json:22` `include:["src"]`；`tsconfig.node.json:13` 只含 3 个配置文件）。→ `desktop/**`（`main.cjs` 47 KB、`preload.cjs`）、`e2e/**`、`scripts/**` **完全不在类型检查内**；`functions/`、`firebase-emulator/` 各有独立 tsconfig 但未挂进 `tsc -b`。 | `tsconfig.app.json:22`；`tsconfig.node.json:13` |
| Q-3 | 确认 Bug | **`playwright.config.ts` 硬编码本机 Chrome 路径**：`launchOptions.executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`。→ CI 或任何没有该路径的机器上 **e2e 必然全部失败**。 | `playwright.config.ts:3`、`:15` |
| Q-4 | 架构 | **e2e 只覆盖 localhost 预览路由**。13 个 spec 中大部分是 `ui-v2-*` 原型与 `review-coach-preview` / `voice-recall-*preview`，而所有这些路由在**原生/桌面平台被守卫主动禁用** → 测试的是「开发服务器 + 原型」，**真实 Android / Electron 运行时零自动化测试**。平台差异最大的部分（insets、返回键、FileProvider、asar 打包）没有任何自动化护栏。 | `playwright.config.ts` baseURL `127.0.0.1:4190`；`e2e/` 13 个 spec |
| Q-5 | 技术债 | e2e 中保留了 `ui-v2-stage2/3/4/5`、`ui-v2-prototype` 等**已迁移完毕的阶段原型** spec，可能是死测试。 | `e2e/ui-v2-*.spec.ts` |
| Q-6 | 技术债 | 死依赖：**`idb-keyval`（package.json:69）在 src / desktop / e2e / functions 中零引用**。另 `highlight.js` 与 `lowlight` 并存（lowlight 内部已依赖 highlight.js），可合并。 | grep 零匹配 |
| Q-7 | 技术债 | `vitest.config.ts:8` `include: ["src/**/*.{test,spec}.{js,ts,jsx,tsx}"]` → `desktop/*.test.ts`、`desktop/*.test.cjs` **不在 vitest 范围内**（`.cjs` 由 `npm run test:voice-host` 用 node 原生 runner 跑，但 `installer.test.ts` / `ocr.test.ts` 两个 `.ts` **实际无人执行**）。 | `vitest.config.ts:8`；`package.json:34`；`desktop/installer.test.ts`、`desktop/ocr.test.ts` |

**推荐处理**：`Q-1` **P1**（加 ESLint 并开启 `no-floating-promises`，收益最高）；`Q-2` **P2**；`Q-3` **P1**（一行删除即可）；`Q-4` **P2**（承认现状即可，但应在文档中写明「平台差异无自动化护栏」）；`Q-5`~`Q-7` **P3**。

---

### 4.19 （附）ZIP 导出 / 备份链路

> 本节与 `docs/audit/zip-export-failure-diagnosis-2026-09-13.md` 是同一批结论（该文件已在上一轮交付）。因备份不属于「云同步 / 自动备份」的排除范围，且问题严重，在此汇总。

**当前状态**：❌ **存在 5 处可复现缺陷，会让「所有备份通道」同时失效。**

**已确认问题**

| # | 类型 | 问题 | 证据 |
| --- | --- | --- | --- |
| R-1 | **确认 Bug** | 完整性校验与「排除播客音频」策略**自相矛盾**。导出用排除播客后的资源列表去校验，但校验要求正文里每个 `record-asset` 都存在 → 记录引用了播客音频就必抛 `备份数据不完整：记录"X"引用的资源 Y 缺失。` | `storageAdapter.ts:1932`、`:2007` → `:1933`、`:2008` |
| R-2 | **确认 Bug** | 任何「正文引用了已不存在资源」的记录/模板都让导出**永久失败**，且无 UI 修复入口。 | `storageAdapter.ts:154-187` |
| R-3 | **确认 Bug** | **孤儿资源清理不扫描模板**：`cleanupOrphanAssetsForRecord` 只遍历 `db.blocks` 与 `db.recordDrafts`，**完全没扫 `db.templates`** → 模板引用的图片会被误判为孤儿删除 → 模板留下悬空引用 → **此后每次导出必然失败**，且**图片不可恢复**。 | `storageAdapter.ts:605-642`（确认无 templates 扫描） |
| R-4 | 确认 Bug | `normalizeSnapshotPodcasts` 直接 `podcast.segments.map(...)`，无兜底（同函数对 `audioUnits` 用了 `?.`）→ 播客行缺 `segments` 时抛 `TypeError`。 | `storageAdapter.ts:138` vs `:143` |
| R-5 | 确认 Bug | 导出写 `payload.podcasts`，但 `zipToSnapshot` **完全不读 podcasts** → 备份里的播客行是死数据，恢复后播客全丢。 | `backup.ts:194-212` |
| R-6 | 确认 Bug | UI 承诺「缺资源会保留占位」，但 `restoreSnapshotData` 第一步就硬校验并中止 → 该提示永远不会出现。 | `BackupPage.tsx:75`；`storageAdapter.ts:2052-2062`、`:2172` |
| R-7 | 架构 | **影响面是四条通道**：`streamingBackupService.ts:120`（Android 手动）、`knowledgeExportService.ts:184`（桌面/网页手动）、`autoBackupAdapter.ts:73`（自动备份）、`nativeAutoBackupStreamService.ts:113` + `nativeRepositoryBackupService.ts:384`（仓库备份）。命中 R-1/R-2/R-3 时**四条一起失效**。 | 调用点 grep 结果 |

**推荐处理**：**R-1/R-2/R-3/R-4 必须修（P0）**；R-5/R-6 建议一起修（P1）。

---

## 5. 问题总表

严重程度：🔴 P0 收口前必修 ／ 🟠 P1 强烈建议修 ／ 🟡 P2 可一起处理 ／ ⚪ P3 记为技术债

| ID | 模块 | 类型 | 严重 | 问题 | 根因 | 影响范围 | 修复波及模块 | 修复风险 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A-1 | App 基础架构 | 确认 Bug | 🔴 | 无 ErrorBoundary / 全局异常兜底，异常即白屏 | 从未引入根级兜底 | 全部页面 | main.tsx、App.tsx、uiError.ts | 低 | 收口前修 |
| A-2 | App 基础架构 | 确认 Bug | 🔴 | 初始化链无 try/catch，失败则永久未初始化 | 单点失败无隔离 | 全应用启动 | useAppData、storage | 低 | 收口前修 |
| K-1 | Error/Feedback | 确认 Bug | 🔴 | `normalizeUiError` 丢弃真实错误且不落日志，诊断编号不可查 | `_error` 形参从未使用 | 全部错误提示 | uiError.ts、所有调用点 | 低 | 收口前修 |
| K-3 | Error/Feedback | 架构 | 🔴 | uiError.ts 的设计意图无落地点（无 ErrorBoundary） | 同 A-1 | 全局 | 同 A-1 | 低 | 收口前修 |
| R-1 | 备份/导出 | 确认 Bug | 🔴 | 完整性校验与播客排除策略自相矛盾 | 两条规则互斥 | 全部备份通道 | storageAdapter | 中 | 必须修 |
| R-2 | 备份/导出 | 确认 Bug | 🔴 | 悬空资源引用使导出永久失败且无修复入口 | 硬校验无降级 | 全部备份通道 | storageAdapter、BackupPage | 中 | 必须修 |
| R-3 | 备份/导出 | 确认 Bug | 🔴 | 孤儿清理不扫 templates，误删资源且不可逆 | `cleanupOrphanAssetsForRecord` 漏扫模板表 | 资源库、模板、导出 | storageAdapter | 中 | 必须修 |
| R-4 | 备份/导出 | 确认 Bug | 🔴 | 播客行缺 `segments` 抛 TypeError | `segments.map` 无兜底 | 全部备份通道 | storageAdapter | 低 | 必须修 |
| H-3 | 安全/Android | 高风险 | 🔴 | `allowBackup=true` 无排除规则，学习数据+明文密钥可被 Android 自动备份到 Google Drive | Manifest 未设置 backup 规则 | 隐私承诺、密钥 | AndroidManifest、新增 xml | 低 | 收口前修 |
| M-1 | Android | 高风险 | 🔴* | targetSdk 36 下 edge-to-edge 强制生效，`setDecorFitsSystemWindows(true)` 与状态栏着色均失效，与 `env(safe-area-inset-*)` 假设冲突 | insets 策略与实际 SDK 行为不匹配 | 全部移动端 UI | MainActivity、全部 CSS inset 使用点 | 中 | 真机核实后决定 |
| H-1 | 配置体系 | 架构 | 🟠 | 配置双源分裂：localStorage 覆盖层与 Dexie settings 互不回写 | 无单一事实源 | 语音复述全链路、设置页 | productionPipeline、providerProfiles、VoiceRecallWorkspace、Settings | 中 | 收口前修 |
| H-2 | 安全/配置 | 高风险 | 🟠 | API Key 明文落库（AI/TTS/ASR/OCR 共用一表） | 无 at-rest 加密 | 四类密钥 | storageAdapter、aiSecrets 消费者 | 中 | 收口前修 |
| F-1 | Learning Coach | 确认 Bug | 🟠 | 分析批次半持久化后重试抛 `duplicate-event`，永久卡死 | 重试未复用已落库实体 id | Coach 分析流程 | orchestrator、repository | 中 | 收口前修 |
| F-2 | Learning Coach | 高风险 | 🟠 | AI 蓝图/任务未经逐项审阅即入跨端同步正式库 | 一次性确认被当作内容确认 | 同步白名单、备份 | orchestrator、schema 白名单、导出剥离 | 中 | 需先确认产品意图 |
| F-3 | Learning Coach | 健壮性 | 🟠 | in-progress 任务无超时/自动放弃，永久卡住并阻塞延迟验证 | 状态机无自动出边 | Coach、延迟验证 | stateMachines、orchestrator | 中 | 收口前修 |
| E-1 | AI | 确认 Bug | 🟠 | `max_tokens` 截断被忽略 → JSON 解析失败且不可重试 | 未判定 `finish_reason === "length"` | AI 结构化输出全链路 | aiClientService、aiGateway、quizExecutionGateway | 中 | 收口前修 |
| E-2 | AI/配置 | 确认 Bug | 🟠 | 内置 provider 默认值疑似无效（`deepseek-v4-pro`、空 model） | 模板未与真实 API 对齐，种子默认值不校验 | AI/TTS 调用 | aiProviders、ttsProviders、AiSettingsPanel | 低 | 先人工核实模型名 |
| E-3 | AI | 高风险 | 🟠 | 会话切换不 abort 旧请求 → 结果写入错误会话；`busy` 闭包可双提交 | 无 request token，abort 仅卸载时 | AI Chat | AiChatPage、aiSessionService | 中 | 收口前修 |
| B-1 | 编辑器 | 高风险 | 🟠 | 多 tab / 多入口并发编辑无冲突检测，静默覆盖 | 无 revision/乐观锁（`baseUpdatedAt` 已有未用） | 记录数据 | storageAdapter、RecordEditorPage | 中 | 收口前修 |
| G-1 | 语音复述 | 健壮性 | 🟠 | 上一轮残流 token 污染下一轮 `teacherDraft` | `setTeacherDraft` 无 generation 守卫 | 语音复述 UI | VoiceRecallWorkspace | 低 | 收口前修 |
| G-3 | 语音复述 | 架构 | 🟠 | `overridesFromConfig` 在 templateId 不匹配时静默丢弃 override | 静默 return undefined | 语音三腿配置 | productionPipeline | 低 | 收口前修 |
| G-4 | 语音复述 | 文档/不一致 | 🟠 | barge-in 已实现但冻结文档称未实现，且未真机验收 | 文档与代码脱节 | 验收口径 | docs、VoiceRecallWorkspace、domain | 低 | 二选一：改文档或补验收 |
| N-1 | Desktop | 确认 Bug | 🟠 | 安装目录与数据根硬编码 `D:\StudyJournal` | 绝对路径写死 | 桌面分发 | installer.nsh、main.cjs | 低 | 收口前修（若分发） |
| N-2 | Desktop | 高风险 | 🟠 | OAuth 生产配置不在仓库，安装包默认无法 Google 登录 | 依赖未入库的 `oauth-config.cjs` | 桌面云同步登录 | main.cjs、打包流程 | 中 | 收口前修（若要该功能） |
| Q-3 | 构建 | 确认 Bug | 🟠 | playwright 硬编码本机 Chrome 路径 → CI 必失败 | 绝对路径写死 | e2e | playwright.config.ts | 低 | 收口前修 |
| Q-1 | 工程质量 | 技术债 | 🟠 | 完全没有 ESLint/Prettier，无 lint 脚本 | 未引入 | 全部源码 | 新增配置文件 + CI | 中 | 强烈建议修（顺带拦 358 处 void） |
| P-4 | 性能/备份 | 健壮性 | 🟠 | 桌面版手动导出全内存，峰值 ≈ 体积 ×2~3，无预警 | 无流式路径 | 桌面/网页导出 | knowledgeExportService、exportPrivacy | 中 | 收口前修 |
| R-5 | 备份/导出 | 确认 Bug | 🟡 | 导出写 podcasts 但导入不读，播客数据丢失 | `zipToSnapshot` 未读 podcasts | 备份完整性 | backup.ts | 低 | 一起处理 |
| R-6 | 备份/导出 | 确认 Bug | 🟡 | UI 承诺「缺资源保留占位」与实际硬中止矛盾 | 恢复路径先校验 | 恢复体验 | storageAdapter、BackupPage | 中 | 一起处理 |
| B-2 | 编辑器 | 健壮性 | 🟡 | 卸载/隐藏时草稿 flush 不 await | `void` + 立即导航 | 草稿数据 | RecordEditorPage | 低 | 一起处理 |
| B-3 | 编辑器 | 健壮性 | 🟡 | 草稿保存失败被静默吞掉 | 调用方无 catch 处理 | 草稿数据 | RecordEditorPage | 低 | 一起处理 |
| B-4 / I-2 | 编辑器/OCR | 健壮性 | 🟡 | OCR 重试可能永久卡 `queued` | 重试仅在内存定时器 | OCR 资产 | ocrJobService、storageAdapter | 中 | 一起处理 |
| C-1 | 复习 | 健壮性 | 🟡 | 投影重建对缺 `stateAfter` 旧日志处理不一致 | 两处过滤条件不同 | 复习数据一致性 | storageAdapter | 中 | 一起处理 |
| C-2 | 复习 | 健壮性 | 🟡 | 时区双轨（UTC + 本地日）脆弱，测试已依赖 UTC+8 | 存储双轨 | 复习 due、日统计 | date.ts、reviewScheduler、storageAdapter | 中 | 一起处理 |
| C-4 | 复习 | 架构 | 🟡 | 评分无显式幂等键 | 依赖事务串行化 | 复习计数 | storageAdapter、ReviewPage | 中 | 一起处理 |
| E-4 | AI | 健壮性 | 🟡 | provider 能力未协商，强制发 `response_format`/`thinking` | 假定统一 OpenAI 协议 | 多 provider 兼容 | aiClientService | 中 | 一起处理 |
| E-5 | AI | 健壮性 | 🟡 | token 仅本地启发式估算 | 无服务端 usage 回退 | 长上下文 | aiContextService | 中 | 一起处理 |
| E-6 | AI | 健壮性 | 🟡 | 成功正文因写库失败而丢失 | 保存与发送未分离 | AI 会话 | AiChatPage | 低 | 一起处理 |
| F-4 | Learning Coach | 架构 | 🟡 | 投影一致性靠全表重算，部分写路径不触发 | 非事件驱动 | Coach 投影 | repository、orchestrator | 中 | 一起处理 |
| F-5 | Learning Coach | 健壮性 | 🟡 | 蓝图可引用已软删反馈，无校验 | 无引用完整性检查 | Coach 数据 | replay.ts、repository | 中 | 一起处理 |
| H-4 | 配置 | 技术债 | 🟡 | 种子默认值不经校验即入库 | 校验仅在保存时 | 首次配置 | aiProviders、AiSettingsPanel | 低 | 一起处理 |
| I-1 | 搜索 | 架构 | 🟡 | 全文搜索全表线性扫描无索引 | 无 FTS/索引 | 大数据量搜索 | search.ts、db schema | 中 | 一起处理 |
| J-1 | 统计 | 架构 | 🟡 | 删除记录后复习统计仍计入（幽灵复习量） | 统计与事实不同源 | 统计准确性 | learningStats、StatsPage | 中 | 一起处理 |
| M-2 | Android | 健壮性 | 🟡 | 无 `values-night`，DayNight 主题可能启动闪色 | 缺夜间资源 | 启动观感 | res/values-night | 低 | 一起处理 |
| O-1 | 持久化 | 配置 | 🟡 | 版本号三处不一致；备份 manifest `appVersion` 硬编码 `0.1.0` | 无统一版本注入 | 恢复兼容判断 | package.json、build.gradle、storageAdapter | 低 | 一起处理 |
| P-1 | 性能 | 性能 | 🟡 | 主包 2,478 kB（gzip 709 kB） | 无更细粒度分包 | 移动端首屏 | vite.config.ts | 中 | 一起处理 |
| P-2 | 性能 | 性能 | 🟡 | PWA 预缓存 ≈19 MB，把 mermaid 全部图表 chunk 拉进 precache | `globPatterns` 过宽 | 安装体积/流量 | vite.config.ts | 低 | 一起处理 |
| Q-2 | 构建 | 架构 | 🟡 | tsconfig 只覆盖 `src`，desktop/e2e/scripts 无类型检查 | include 范围过窄 | 构建质量 | tsconfig.* | 中 | 一起处理 |
| Q-4 | 测试 | 架构 | 🟡 | e2e 只测 localhost 预览路由，真实平台零自动化护栏 | baseURL 只指向 dev server | 平台回归 | playwright.config.ts、e2e | 中 | 一起处理（或明确记录） |
| B-4 剩余 | 编辑器 | 健壮性 | 🟡 | decision-block 解析失败无可观测信号 | 静默容错 | 排障 | storageAdapter | 低 | 一起处理 |
| A-3 | App 基础架构 | 健壮性 | 🟡 | StrictMode 双挂载重复执行初始化副作用 | cleanup 未 abort | 启动副作用 | useAppData | 中 | 一起处理 |
| A-6 | App 基础架构 | 健壮性 | 🟡 | 缺少 background→foreground 恢复逻辑 | 无恢复钩子 | 后台返回体验 | useAppData、App | 中 | 一起处理 |
| A-4 / A-5 | App 基础架构 | 架构 | 🟡 | App.tsx 1821 行、useAppData 80+ 出口、ReviewPage 55 props | 中心化巨构 | 全部页面 | App.tsx、useAppData、ReviewPage | 高 | 不建议现在动 |
| G-2 | 语音复述 | 技术债 | ⚪ | audio generation 门控部分失效，成为死值 | `enqueueAudio` 忽略 generation | 语音内部 | runtimeController | 中 | 记录技术债 |
| G-5 | 语音复述 | 健壮性 | ⚪ | 原生回声消除/音频焦点未真机验收 | 已声明开放门槛 | 语音体验 | Android 原生 | 高 | 记录技术债 |
| G-6 | 语音复述 | 技术债 | ⚪ | policy 预览与真实会话共用 Workspace，仅靠主机名区分 | 复用组件 | 语音测试 | App.tsx | 低 | 记录技术债 |
| D-1 | 复习 UI | 健壮性 | ⚪ | 会话进度不持久化，刷新后已评卡片重现 | 未持久化 session | 复习体验 | ReviewPage | 中 | 记录技术债 |
| D-2 | 复习 UI | UX | ⚪ | rating 缺少显式「提交中」视觉禁用 | 单飞标志无视觉 | 复习体验 | ReviewPage | 低 | 记录技术债 |
| C-3 | 复习 | 数据模型 | ⚪ | 同日重评 elapsed_days=0，不触发 lapse 惩罚 | 同日 correction 语义 | 复习语义 | reviewScheduler | 高 | 记录技术债 |
| C-5 | 复习 | 技术债 | ⚪ | 切换 reviewKind 重置 FSRS 连续性，未提示用户 | 业务规则 | 复习语义 | storageAdapter | 中 | 记录技术债 |
| J-2 | 统计 | 健壮性 | ⚪ | 趋势条 width 未防 undefined/NaN | 展示层假设过强 | 统计展示 | StatsPage | 低 | 记录技术债 |
| I-1 剩余 | 搜索 | 技术债 | ⚪ | 三处 `deletedAt` 防御策略不一致（输入侧过滤、函数内不防御） | 靠约定而非类型 | 搜索一致性 | search.ts、aiContextService | 低 | 记录技术债 |
| L-2 | UI/UX | UX | ⚪ | 评分撤回不持久化，刷新后无法撤回 | App 级 runtime | 复习体验 | App.tsx | 中 | 记录技术债 |
| Q-5 | 测试 | 技术债 | ⚪ | e2e 保留已迁移完成的 ui-v2 阶段 spec | 未清理 | CI 时间 | e2e | 低 | 记录技术债 |
| Q-6 | 依赖 | 技术债 | ⚪ | `idb-keyval` 零引用；`highlight.js` 与 `lowlight` 并存 | 未清理 | 依赖体积 | package.json | 低 | 记录技术债 |
| Q-7 | 测试 | 技术债 | ⚪ | `desktop/installer.test.ts`、`desktop/ocr.test.ts` 无人执行 | include 范围不匹配 | 测试盲区 | vitest.config.ts | 低 | 记录技术债 |
| N-3 | 构建 | 技术债 | ⚪ | 构建脚本硬编码 JDK 路径与期望版本号 | 路径写死 3 处 | 换机构建 | scripts | 低 | 记录技术债 |
| N-4 | 构建 | 技术债 | ⚪ | icon 生成脚本 fire-and-forget，失败形态不显式 | `void createIcon()` | 桌面打包 | scripts | 低 | 记录技术债 |
| M-3 | Android | 健壮性 | ⚪ | 无 `onSaveInstanceState`，低内存被杀后内存态丢失 | 未实现 | 后台恢复 | MainActivity | 中 | 记录技术债 |
| M-5 | Android | 技术债 | ⚪ | release 未启用 minify | `minifyEnabled false` | 包体 | build.gradle | 中 | 记录技术债 |

\* M-1 标为 🔴 的前提是「真机核实确认存在遮挡」；在核实前应按 P1 处理。

---

## 6. 模块依赖 / 修改波及关系

### 6.1 核心依赖图

```text
                        ┌──────────────────────────────┐
                        │  src/db/database.ts          │
                        │  Dexie schema v21            │  ← 数据地基
                        │  （23 个迁移测试覆盖）        │
                        └──────────────┬───────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │  src/services/storageAdapter │  ← 本地持久化唯一入口
                        │  2328 行                     │
                        │  ├ 记录 / block / 资源        │
                        │  ├ 复习事实 + 投影            │
                        │  ├ 快照 createSnapshot() ★    │
                        │  └ 恢复 restoreSnapshotData() │
                        └───┬───────┬───────┬───────┬──┘
                            │       │       │       │
        ┌───────────────────┘       │       │       └────────────────────┐
        │                           │       │                            │
┌───────▼────────┐        ┌─────────▼──┐  ┌─▼──────────────┐   ┌─────────▼────────┐
│ src/hooks/     │        │ services/  │  │ services/      │   │ services/        │
│ useAppData     │  ★★    │ backup.ts  │  │ streaming      │   │ exportPrivacy    │
│ 1086 行        │        │（四大备份 │  │ BackupService  │   │                  │
│ 80+ 出口       │        │  通道共用）│  │（Android 流式）│   │                  │
└───────┬────────┘        └────────────┘  └────────────────┘   └──────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────────┐
│  src/App.tsx  1821 行 / 77 KB  ★★★                              │
│  持有：导航 + tabMemory + reviewRuntime + theme + 4×toast + 键盘  │
└──┬────────┬────────┬────────┬────────┬────────┬────────┬────────┘
   │        │        │        │        │        │        │
┌──▼──┐ ┌──▼──┐ ┌───▼───┐ ┌──▼───┐ ┌──▼───┐ ┌──▼────┐ ┌▼─────────┐
│Today│ │Journ│ │Review │ │Stats │ │AI 页 │ │设置页 │ │语音复述   │
│ Page │ │ Page│ │Page   │ │ Page │ │Chat/ │ │Settings│ │Workspace │
│      │ │     │ │1520 行│ │      │ │Tools │ │/OCR   │ │1125 行   │
└──────┘ └─────┘ └───┬───┘ └──────┘ └──┬───┘ └───┬───┘ └────┬─────┘
                     │                  │         │          │
              ┌──────▼───────┐  ┌───────▼──────┐  │   ┌──────▼────────┐
              │ features/    │  │ services/    │  │   │ features/      │
              │ reviewCoach  │  │ aiContext    │  │   │ voiceRecall    │
              │ 1332+927 行  │  │ aiClient     │  │   │ production     │
              │ repository/  │  │ 上下文构建   │  │   │ Pipeline       │
              │ orchestrator │  └───────┬──────┘  │   └──────┬─────────┘
              └──────┬───────┘          │         │          │
                     │                  │         │          │
              ┌──────▼──────────────────▼─────────▼──────────▼─────────┐
              │  ★★★ 【配置入口 —— 无单一事实源，本报告最重的架构问题】  │
              │  Dexie settings.ai / settings.tts  ← 设置页写，AI 读      │
              │  Dexie aiSecrets（明文）           ← AI/TTS/ASR/OCR 共用  │
              │  localStorage voice-recall.config  ← 只语音复述读（隔离!）│
              │  BUILT_IN_* 内置常量               ← fallback，部分死值  │
              └──────────────────────────────────────────────────────────┘
```

### 6.2 高耦合 / 高风险公共基础设施

| 模块 | 性质 | 为什么危险 |
| --- | --- | --- |
| `storageAdapter.ts`（2328 行） | **单点 source of truth** | 全部本地读写、快照、恢复都经过它。「导出/恢复」的 5 处缺陷全部在这一个文件里，改它等于改数据安全边界 |
| `settings.ai` / `settings.tts` / `aiSecrets` | **单点 source of truth（但被影子层绕过）** | 四类密钥共一张表；改 `aiSecrets` 会同时影响 AI / TTS / ASR / OCR |
| `localStorage voice-recall.config` | **影子覆盖层** | 与 Dexie 完全隔离且不回写 → 「设置页显示的值」和「实际使用的值」可以永久不一致 |
| `useAppData`（80+ 出口 / 1086 行） | **中心状态广播器** | 改任一出口都可能影响多个页面；无类型级别的调用约束 |
| `App.tsx`（1821 行 / 55 props 透传） | **中心组件** | 所有导航/全局态集中于此；任何 tab 行为调整都要动它 |
| `uiError.ts`（53 行） | **全局错误出口** | 全部用户可见错误经过它；改文案/加日志是全局影响、但风险极低（正因如此才是高收益） |
| `src/db/database.ts`（schema v21） | **数据地基** | 迁移写错会导致不可逆数据损坏；幸好有 23 个迁移测试 + 失败回滚测试守护 |

### 6.3 可以独立、安全修复的模块（低波及）

以下问题的修复**不牵动公共基础设施**，可以单独验收：

| 问题 | 为什么安全 |
| --- | --- |
| A-1 / K-3（ErrorBoundary） | 纯新增一层，不改既有组件树 |
| K-1（错误日志） | 改 1 行，界面文案不变，隐私约定不变；有 `uiErrorSurface.test.ts` + `uiError.test.ts` 守护 |
| H-3 / M-4（`allowBackup`） | 改 Manifest 一行 + 新增一个 xml |
| Q-3（playwright 路径） | 删 2 行 |
| G-1（draft 守卫） | 加 1 行守卫，与采集侧已有写法对齐 |
| R-4（segments 兜底） | 加 `?.` + `?? []`，与同函数 `audioUnits` 写法对齐 |
| R-3（孤儿清理补扫 templates） | 在既有循环旁加一段扫描，不改调用方 |
| M-2（values-night） | 纯新增资源目录 |
| O-1（版本号统一） | 改常量来源，不动数据 |
| Q-6（删死依赖） | 删 1 个包 |

### 6.4 牵一发动全身的模块（改动需完整回归）

| 模块 | 波及其他 |
| --- | --- |
| `storageAdapter.createSnapshot / createStreamableSnapshot / assertSnapshotIntegrity / restoreSnapshotData` | 四条备份通道 + 恢复 + 记录转移 + decision-block 导入 + 知识导出 |
| `settings` / `aiSecrets` 配置结构 | AI Chat、AI Tools、AI Export、Learning Coach 全部 AI 网关、知识播客、语音复述三腿、OCR、设置页 |
| `App.tsx` 导航状态与 `reviewRuntime` | 全部 tab、返回键行为、tab 记忆、评分撤回 |
| `useAppData` 出口签名 | 全部页面与组件 |
| `database.ts` schema 版本 | 迁移、备份兼容、设备本地表边界（`AGENTS.md` 的存储契约） |
| `reviewCoach/repository` 投影重建 | Coach 全流程、复习重点反馈、延迟验证、统计 |
| `recordContent.syncRecordRefsFromContent` | 保存、快照完整性、复习卡片提取 |

---

## 7. 收口建议（按优先级排序，**本轮未实施任何修改**）

### P0 —— 收口前必须修

| 序 | 问题 | 理由 | 改动量 | 修复风险 |
| --- | --- | --- | --- | --- |
| 1 | **K-1 错误可见性**（`uiError.ts` 补一行 `console.error`） | 它是「其他所有问题都查不出来」的根因；一行改动，且能立刻让下次失败可定位（含你这次的 ZIP 导出） | 极小 | 低：界面文案与隐私约定不变，两个既有测试守护 |
| 2 | **A-1 / K-3 加根级 ErrorBoundary + 全局异常钩子** | 当前任何未捕获异常即白屏不可恢复；这是「能否正常使用」的门槛 | 小 | 低：纯新增一层 |
| 3 | **A-2 初始化链加异常隔离** | 投影重建或延迟验证失败会让 App 永久打不开，且用户无自救手段 | 小 | 低：加 try/catch + 失败态页面 |
| 4 | **R-1 / R-2 / R-4 备份完整性策略** | 备份是数据的最后防线；当前「一条悬空引用 = 永远无法备份」 | 中 | 中：需决定「硬校验 vs 降级警告」的策略，建议降级为「导出成功 + 明确报告 N 处引用失效」 |
| 5 | **R-3 孤儿清理补扫 `db.templates`** | 会**不可逆地删除**仍被模板引用的图片/音频，并永久打断导出 | 小 | 低：在既有循环旁加模板扫描 |
| 6 | **H-3 / M-4 关闭 `allowBackup` 或加排除规则** | 产品宣称「纯本地、离线优先」，但 Android 自动备份会把学习数据 + **明文 API Key** 送上 Google Drive | 极小 | 低：Manifest + 一个 xml |
| 7 | **M-1 Android insets 策略**（先真机核实） | targetSdk 36 下 `setDecorFitsSystemWindows(true)` 与状态栏着色均已失效，与 Web 侧 safe-area 假设冲突 | — | 需先核实，再二选一（启用 edge-to-edge 统一处理 / 回退 targetSdk 34） |

### P1 —— 强烈建议修（不修明显影响稳定性或后续维护）

1. **H-1 配置源统一** —— 需你先做一个产品决策：以 Dexie `settings` 为唯一 source of truth，把 localStorage 降级为纯 UI 偏好；**至少**让 `templateId` 不匹配时显式报错而非静默丢弃。（这是本轮最重的架构问题，但**只需一次决策 + 局部改动**，不需要大重构）
2. **H-2 API Key 明文存储** —— 至少记录为已知风险；若做加密，注意四类密钥共用一张表，需一次改完。
3. **F-1 / F-3 Learning Coach 重试与孤儿任务** —— 影响可用性（一个任务卡死会让整条链路不可用）。
4. **F-2 AI 建议入正式库的边界** —— 涉及同步白名单与数据边界，**需你确认产品意图**后再动。
5. **E-1 AI 截断检测、E-3 AI 会话串台/双提交** —— 直接影响 AI 功能可用性。
6. **E-2 内置默认模型** —— 先人工核实 `deepseek-v4-pro` 是否真实存在，再决定改值或加校验。
7. **B-1 多 tab 并发编辑冲突检测** —— 草稿已带 `baseUpdatedAt`，接上即可。
8. **G-1 / G-3 语音复述的状态守卫与配置静默丢弃**。
9. **G-4 barge-in 文档与实现对齐** —— 二选一，不能维持矛盾状态。
10. **N-1 / N-2 桌面硬编码路径与 OAuth 配置** —— 若确定不分发可降为 P2。
11. **Q-1 引入 ESLint** —— 顺带开启 `no-floating-promises`，可直接拦下 358 处 `void` 中的真实风险。
12. **Q-3 playwright 硬编码路径**。
13. **P-4 桌面导出全内存**（与 R 系列一起处理更经济）。

### P2 —— 可以一起处理

`R-5` `R-6` `B-2` `B-3` `B-4/I-2` `C-1` `C-2` `C-4` `E-4` `E-5` `E-6` `F-4` `F-5` `H-4` `I-1` `J-1` `M-2` `O-1` `P-1` `P-2` `Q-2` `Q-4` `A-3` `A-6` `B-4剩余`

### P3 —— 记录为技术债（当前不要为了收口而改动）

`G-2` `G-5` `G-6` `D-1` `D-2` `C-3` `C-5` `J-2` `I-1剩余` `L-2` `Q-5` `Q-6` `Q-7` `N-3` `N-4` `M-3` `M-5`

### 明确不建议现在动的

- **A-4 / A-5（App.tsx / useAppData 巨构拆分）**：风险等级「高」。这是一次跨全部页面 props 契约的重构，**收益是未来的可维护性，风险是当期回归**。当前目标是最少风险地收口 → **明确不建议现在动**。建议在 README 或 AGENTS 中记录为已知架构债，留到下一个开发周期。
- **C-3（同日重评 lapse 语义）**：改动会触及 FSRS 数据模型，且涉及「什么算遗忘」的产品语义。**建议只在文档中写明当前语义**，不动算法。
- **H-2 密钥加密**（如果会牵动同步/备份契约）：需先确认密钥是否已在任何快照中落库，否则加密改一半会造出「有的加密有的明文」的更差状态。

---

## 8. 最终回答三个问题

### 8.1 当前项目是否已经基本达到「可以收口」的状态？

**接近，但还不能直接收口 —— 差 7 项 P0。**

代码本身的工程质量**明显高于同类个人项目**：8 万行 TypeScript 零 `any`、零 `@ts-ignore`、零调试残留、1015 个测试全绿、23 个 schema 迁移测试、安全规则正确、密钥文件无一入库。SSRS 调度、DB 迁移、TTS/ASR 协议这些最容易出错的地方反而是做得最扎实的地方（FSRS 调用经逐项复核**正确**，语音 ASR→LLM→TTS 闭环经复核**完整成立**，Android 麦克风互斥在原生层**双向强制**）。

所以问题不是「项目不行」，而是**几处关键的可靠性兜底没做**，以及**一处配置架构分裂**。

### 8.2 如果不能收口，最主要的阻碍是什么？

**三个，按重要性排序：**

1. **错误不可见（K-1 + K-2 + A-1）** —— 这是**最根本的阻碍**。58 处静默吞错 + `normalizeUiError` 主动丢弃错误对象 + 零 ErrorBoundary，三者叠加导致「出了任何问题都查不出原因」。你这次 ZIP 导出失败只看到一句「操作没有完成」就是它的直接产物。**不修它，其他所有修复都无法验证是否真的生效。** 好在修它只需一行日志 + 一层 ErrorBoundary。

2. **备份通道整体脆弱（R-1 ~ R-4）** —— 备份是离线优先产品的最后防线，而现在「一条悬空资源引用」就能让四条备份通道同时永久失效，且 `cleanupOrphanAssetsForRecord` 会**不可逆地**制造这种悬空引用。

3. **配置体系没有单一事实源（H-1 + H-2 + H-3）** —— 用户改了 TTS 模型但语音复述仍用旧值；API Key 明文存储；Android 自动备份还会把明文密钥带上 Google Drive。这是「架构问题」，但**不需要大重构**，只需要一次决策 + 局部改动。

### 8.3 如果现在开始修复，哪些问题应该一起修，哪些问题应该严格分开修？

#### 应该一起修（同一根因或同一文件，合并做最经济）

| 批次 | 一起修的问题 | 理由 |
| --- | --- | --- |
| **批次 1：错误可见性** | `K-1` + `A-1` + `K-3`（+ `A-2`） | 同一件事的三个面：错误要么被吞、要么无处承接。都集中在 `uiError.ts` / `main.tsx` / `App.tsx` / `useAppData.ts`，一次改完、一次验收 |
| **批次 2：备份与资源安全** | `R-1` + `R-2` + `R-3` + `R-4`（+ `R-5` + `R-6` + `P-4`） | 全部集中在 `storageAdapter.ts` 的导出/恢复/清理三处；`R-3` 是 `R-1`/`R-2` 的根因制造者，分开修会出现「修了校验但仍在制造悬空引用」的半成品状态 |
| **批次 3：配置单一事实源** | `H-1` + `G-3` + `H-4` + `E-2` + `H-5` | 全部是「配置从哪来、谁说了算」；一起改才能一次把影子层收掉，否则改了 Dexie 又被 localStorage 覆盖 |
| **批次 4：Android 合规** | `H-3` + `M-4` + `M-2` + `M-1` | 全在 Android 侧，且 `M-1` 需要真机验证 —— 一次装包验证全部 |
| **批次 5：AI 可靠性** | `E-1` + `E-3` + `E-6` | 全在 `aiClientService` / `AiChatPage`，同一请求生命周期 |
| **批次 6：构建与检查** | `Q-1` + `Q-3` + `Q-2` + `Q-7` | 都是「让工具链真的跑起来」；引入 ESLint 后能顺手拦住 `K-2` 的 358 处 `void` |

#### 应该严格分开修（避免互相掩盖）

| 问题 | 为什么必须单独做 |
| --- | --- |
| **`A-4` / `A-5`（App.tsx / useAppData 巨构拆分）** | **绝对不要和上面任何批次混做**。它会改动全部页面的 props 契约，一旦混入，上面所有修复的「验收是否通过」都会失去可归因性。**建议本阶段完全不做。** |
| **`C-2`（时区双轨）** | 涉及日期语义，必须配「固定 TZ 的测试」独立验收，混在其他批次里无法判断回归来自哪 |
| **`F-2`（AI 建议入正式库边界）** | 涉及同步白名单与备份导出剥离，改动会跨到本轮排除的两个模块（云同步/自动备份），必须**单独一个变更窗口**并单独回归 |
| **`H-2`（密钥加密）** | 涉及已落库数据，「改一半」会造出明文+密文混合的更差状态；必须先盘清密钥是否已存在于任何历史快照/备份中 |
| **`C-3`（同日重评 lapse 语义）** | 改的是**产品语义**而不是 bug；建议本阶段不动，只在文档写明 |

#### 一句话总结

> **先修「能不能看见错误」（批次 1），再修「数据丢不丢」（批次 2），然后修「配置听谁的」（批次 3）。**
> 批次 1 只需一行日志加一层兜底，却是后面所有修复能被验证的前提。
> 至于 `App.tsx` 1821 行的巨构 —— 它确实是最大的长期架构债，但**现在动它的风险远大于收益**，建议明确记录为已知债务，留到下一周期。

---

## 附录 A：本轮复核后**否定**的结论（防止误修）

| 曾被提出的问题 | 复核结论 | 依据 |
| --- | --- | --- |
| 已删除记录仍出现在搜索结果 | ❌ **不成立** | `useAppData.ts:89/104` 用的是 `storage.listBlocks()`，而 `listBlocks()`（`storageAdapter.ts:866-868`）已过滤 `!block.deletedAt`。输入侧已完成过滤。（仅剩「函数内不防御」的技术债） |
| `ImageLightbox` 未拦截返回键，会与全局返回冲突 | ❌ **不成立** | `App.tsx:739` 检测到 `.image-lightbox` 时主动 return 不处理；`ImageLightbox.tsx:203-217` 自身注册监听并 `closePreservingScroll()`。协作正确 |
| `build/icon.ico` 未入库会导致构建失败 | ⚠️ **已缓解** | `desktop:build` 会先执行 `scripts/create-desktop-icon.cjs` 从 `public/pwa-512.svg` 重新生成。仅剩「fire-and-forget 失败形态不显式」的技术债 |
| `vite build` 失败 | ❌ **环境限制** | 仅因本审查环境的批量删除保护拦截清空 `dist/`（137 > 阈值 50）。换 `--outDir dist-verify` 后构建成功 |
| 预览/调试路由会在生产环境误触发 | ⚠️ **8/10 正确，2/10 有缺口** | `stage3PreviewSeed.ts` 全部 7 个守卫 + `App.tsx:112` 的生产预览守卫都正确排除 native/desktop。但 **`UiV2PrototypeApp.canPreviewUiV2`（`:102-106`）与 `VoiceRecallPrototypeApp.canPreviewVoiceRecall`（`:40-43`）只检查主机名`。注意：Capacitor `androidScheme:"https"` 下 Android 内 WebView 的 hostname **就是 `localhost`**，所以这两处守卫在原生环境**不构成有效排除**。当前无实际触发路径（无 deep-link intent-filter），故列为健壮性缺口而非确认 Bug） |
| 定时器泄漏（setInterval 4 : clearInterval 3） | ❌ **不成立** | 第 4 处匹配是 `ReturnType<typeof setInterval>` 的类型引用，非真实调用。实际 3:3 平衡 |
| 提交了敏感信息 | ❌ **不成立** | `.env` / `keystore.properties` / `google-services.json` / `oauth-config.cjs` 全部未跟踪 |

## 附录 B：本轮**未覆盖**的领域（如实声明）

1. **远端最新代码** —— 网络不通，未能拉取；若远端有新 commit，结论需重核。
2. **云同步 / 自动备份内部策略** —— 按你的要求排除。
3. **真实 Android 真机行为** —— `M-1`（insets）、`G-5`（回声消除/音频焦点）只有真机能判定。
4. **Electron production 安装包的实际安装/运行** —— 只做了静态审查（含 asar 路径与隔离配置核对），未实际执行 `desktop:build` 并安装验证。
5. **真实 AI provider 的端到端行为** —— 涉及付费调用，未执行（`2 个 live 测试`按要求跳过）。
6. **`e2e` Playwright 套件** —— 未运行（环境无硬编码路径上的 Chrome，且开发服务器会占用端口）。
7. **性能基准测试** —— 只做了工程层面静态审查，未做专业 benchmark。
