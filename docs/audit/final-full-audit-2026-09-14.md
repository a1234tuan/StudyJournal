# StudyJournal 收口阶段 · 全规模工程审计报告

**审计类型**：只读工程审计（未修改任何源码、配置、数据库；未提交 commit / PR）
**审计对象**：`D:\StudyJournal-Source`（remote: `https://github.com/a1234tuan/StudyJournal.git`，分支 `main`）
**审计日期**：2026-09-14
**审计基线 commit**：`6463c793abd54c3e7495d3b5da64cb6dad948553`（`docs: add audit reports, voice-context plan, and full-audit prompt`）
**审计对象说明**：审计对象是**工作区现状**而非仅 `HEAD`。审计开始时工作区除 `img/`、`output/`、`dist-verify-audit/` 三个未跟踪目录外是干净的。

---

## 0. 审计方法与局限

**执行方式**：按模块分组（M01–M23）分六路并行深审，每路逐条求证种子假设（H1–H47）并给出「成立 / 不成立 / 证据不足」的明确结论。随后对最高严重度的 6 条结论由主审亲自复核源码并复测，复核通过才进入问题总表。

**⚠️ 关于测试数值的一次重要纠正（请先读）**

本次审计的某个并行子任务在多任务并发（子任务自身 + 全量测试同时运行）的负载下报告了「162 文件中 159 通过、3 失败」（2 项 5 秒超时 + 1 项 `auditRegression` R11），并据此推断存在「语音暂停路径非法状态迁移」。**该结论已被复测证伪**：

- 三个被点名的文件**单独运行全部通过**：43/43（`storageAdapter.restore.test.ts` 7/7、`storageAdapter.review.test.ts` 20/20、`voiceRecall/auditRegression.test.tsx` 16/16），其中 R11 用例 `R11 saves nonzero measured usage in local history` 明确通过。
- **无并发负载下全量重跑两次**（16:08 与 18:14），均为 `Test Files 162 passed (162)` / `Tests 1011 passed (1011)` / `exit 0`。
- 该子任务报告中的 `VoiceRecallTransitionError: idle -> PAUSE` 未处理拒绝，在干净运行中**零出现**（`grep -c` = 0）。

**根因**：`storageAdapter.restore.test.ts` 与 `storageAdapter.review.test.ts` 的最慢用例分别耗时 2.5–3.5 秒，而超时阈值为 5 秒——**余量过小**，并发负载下必然假失败。这本身是一条值得记录的测试基础设施脆弱性（见 **F-29**）。因此本报告不采纳任何基于该次污染运行的结论。

> 该子任务的原始草稿已归档为 `docs/audit/superseded-subagent-draft-2026-09-14.md`。经复核，其 4 条实质结论全部属于「已被复测证伪」或「与既有审计重复登记」，未丢失有效发现。本报告为最终版本。

**明确局限**：

- 未执行任何真实付费 Provider 调用（阿里云 ASR、DeepSeek、Fish Audio、豆包、PaddleOCR 均未打通）。
- 未在真机（Android 物理设备）与 Electron 运行时验证；相关结论标注`【仅静态推断】`。
- 未运行 `npm run test:firebase`（需 Firebase Emulator 与 JDK 环境），云端规则结论由代码对读得出。
- 未执行 Gradle 编译（未构建 APK）。

---

## 1. 确定性证据（真实执行输出）

| 命令 | 结果 |
| -- | -- |
| `git rev-parse HEAD` | `6463c793abd54c3e7495d3b5da64cb6dad948553` |
| `git status --short` | 仅 `?? img/`、`?? output/`、`?? dist-verify-audit/`（均为本地素材/构建产物，未纳入提交） |
| `npx tsc -b` | **exit 0**（零类型错误） |
| `npm run test -- --exclude "**/*.live.test.ts"` | **162 个测试文件全部通过 / 1011 项测试全部通过 / exit 0**（两次独立复现：54.43s、59.46s） |
| `npm run test:voice-host` | **2 通过 / 0 失败**（`host sends text control frames and binary PCM to a real local server`、`host rejects sends after close`） |
| `npx vite build` | **exit 0**（19.72s，PWA precache 109 项 / 19545.97 KiB） |
| `git diff --check` | **exit 0** |
| `npx playwright test --output <独立目录>` | **54 项 collected：49 passed / 1 skipped / 4 在收尾阶段报错** |

**三点必须说明的偏差：**

1. **测试数字与 `AGENTS.md` 不符**。`AGENTS.md:88` 声称「163 个确定性 Vitest 文件 / 1021 项测试」，实测为 **162 文件 / 1011 项**（差 1 文件、10 项）。`AGENTS.md` 的数字已偏旧，应更新（→ F-23）。
2. **Playwright 的 4 项「失败」不是产品缺陷**。4 项均报 `browserContext.close: EPERM: operation not permitted` 与 `[safe-delete] SAFE_DELETE_BULK_CONFIRM_REQUIRED`——是本审计沙箱禁止批量删除 trace 文件导致**收尾阶段**失败，测试断言本身已执行完毕。54 collected 与 `AGENTS.md` 的「54 个 Playwright 用例」**完全吻合**，可作为交叉验证。
3. **`npm run test:e2e` 在默认输出目录下会被沙箱直接拦死**：`test-results/playwright` 有 70 项 > 批量删除阈值 50，命令在**启动阶段**即失败。必须用 `--output` 指向独立目录才能跑通。属环境限制，记录以便复现。

另：单测运行产生 **32 条 `not wrapped in act(...)` 警告**（两次运行均可复现），源头指向 `ReviewAnnotationSurface`（经 `ReviewPage.test.tsx` 触发）——测试卫生问题，非产品 Bug（→ F-24）。

---

## 2. 总体结论

**健康度：良好。核心不变量落实度高，但存在 2 条 P0 级数据可用性缺陷必须先修，才能宣布收口。**

正面结论（本次审计最有价值的部分之一）：

- **语音复述的三张本机表与批注草稿的数据边界是干净且被强制执行的。** 穷举了全部序列化/上传/导出路径（云同步实体映射、ZIP、流式备份、原生仓库备份、autoBackup、知识导出、记录转移、`exportPrivacy`、快照创建/恢复），`voiceRecallSessions` / `voiceRecallTurns` / `voiceRecallLocalHistory` / `reviewAnnotationDrafts` **在所有路径上都被排除**；批注写入也**未**触发云变更记账。
- **云同步不存在「漏映射字段导致静默丢数据」。** `cloudSyncModel` 采用整对象序列化，新增字段自动入映射；本次做了实体级字段对照，未发现丢字段。
- **12 个近期重构提交逐个体检，未发现成立的静默回归**（导出改名、持久化键改名无迁移、路由/query 改名、设置项改名导致凭据失配——四类全部不成立）。
- **「假接口」几乎没有。** 全量接口分类结果为 `FAKE: 0`、`REGRESSED: 0`；`DEAD: 6` 条均为可安全清理的残留。

需要立刻处理的问题集中在 **备份/导出链路的完整性校验**（F-01、F-02）：这两条会让用户**永久无法导出数据**，且第二条还会**不可逆地删除被模板引用的图片**。

**是否可进入收口**：修完 F-01、F-02 后可进入收口维护阶段；F-03～F-10 建议同批修完；其余为清理项。

---

## 3. 覆盖矩阵（23 个模块，无空缺）

| # | 模块 | 结论 | 主要发现 |
|---|------|------|---------|
| M01 | 启动 / 全局架构 / 路由 | 有隐患 | F-03、F-13；`uiError` 硬约束满足；`refresh()` 与并发写存在 stale snapshot 风险 |
| M02 | 数据层 / 迁移 / schema | 健康 | 迁移经 Dexie 事务，幂等可重试；schema 21 定义与写入一致 |
| M03 | 日志 / 记录 / 今日 / 收藏 / 回收 | 健康 | 未发现 P0–P2；`record.date` 来源为本地 `todayISO()`，正确 |
| M04 | 编辑器 / 富文本 / 结构块 | 有隐患 | F-18；IME 守卫、`trailingEditableParagraph`、资源释放均健康 |
| M05 | Markdown / 序列化 / 内容抽取 | 有问题 | F-04、F-05；H26 公式双计修复完整、无同类残留 |
| M06 | 复习 / FSRS / 复习流程 | 有隐患 | F-07；语音确认不写 FSRS（正确）；模块整体无专项测试 |
| M07 | 复习批注 | 健康 | 设备本地隔离扎实；`writeGeneration` 并发守卫覆盖 open/upsert/clear；F-20 孤儿测试 |
| M08 | Review Coach / Learning Coach | 健康 | 正式写全部经 `repository.ts`，无越权写入；投影仅从正式事实重建 |
| M09 | AI 能力 / AI Cockpit | 有隐患 | F-15、F-28；`aiRetry` 确定性失败不重试、signal 全程贯穿、预算不越界（均正确） |
| M10 | 语音复述 / Voice Tutor | 有隐患 | F-06、F-10；H1 数据边界**成立且干净**（本次最重要负面确认） |
| M11 | TTS / 知识播客 | 有隐患 | F-09、F-26；前台服务所有退出路径均停通知；V1/V2/V3 均非死代码 |
| M12 | OCR | 有隐患 | F-08、F-19；Web 端 OCR 为**诚实报错**而非静默假成功 |
| M13 | 搜索 | 有隐患 | F-14（架构性性能债，非功能缺陷） |
| M14 | 统计 / 数据可视化 | 有隐患 | F-12 |
| M15 | 备份 / 恢复 / 导出 / 转移 | **有问题** | **F-01、F-02、F-16、F-17**；四条导出通道的隐私剥离一致（正确） |
| M16 | 云同步 / Firebase | 健康 | append-only 成立、no-op 跳锁成立、大额确认不可绕过、规则与函数契约一致 |
| M17 | 媒体 / 附件 / 图片 | 健康 | 作用域内零 ObjectURL / AbortController 泄漏 |
| M18 | 设置中心 / 导航 / 布局基础 | 有隐患 | F-03 的 3 处落点；使用教程条目全部对应真实入口（**假接口排查通过**） |
| M19 | 视觉层 / 样式 | 健康 | 层级设计正确；`src/styles/*.test.ts` 实为源码文本断言（非渲染测试，属测试质量债） |
| M20 | 预览壳 / 调试入口 | 有隐患 | F-10 |
| M21 | Android 宿主 | 有隐患 | F-11、F-25；录音/播放/前台服务/备份/Zip 主链路释放规范 |
| M22 | Desktop 宿主 | 健康 | IPC 三向对齐无孤儿通道；`files` 配置无遗漏 |
| M23 | 构建 / 测试基础设施 | 有隐患 | F-27、F-29；e2e 断言抽样均为强断言，非弱断言 |

---

## 4. 问题总表

> 严重度口径：`P0` 数据丢失/泄漏/安全/崩溃且用户可感知；`P1` 功能错误或不可用；`P2` 边界条件下出错或体验退化；`P3` 清理项 / 维护陷阱。
> 「复核」列：`主审复核` = 本次由主审亲自读源码/复测确认；`子任务` = 由审计子任务提供证据，未二次复核。

| ID | 严重度 | 模块 | 位置 | 现象 | 触发路径 | 置信度 | 复核 |
|---|---|---|---|---|---|---|---|
| **F-01** | **P0** | M15 | `src/services/storageAdapter.ts:1933`（断言实现 `:154-187`） | **备份完整性校验与播客资源排除策略自相矛盾**：`createSnapshot` 用 `backupAssets`（已过滤掉 `generatedBy === "knowledge-podcast"`）调用 `assertSnapshotIntegrity`，而该断言（`:166-186`）要求记录/模板引用的每个资源都必须在列表里 | 记录正文中引用了一张由知识播客生成的音频资源 → 抛出 `备份数据不完整：记录"…"引用的资源 … 缺失。` → 之后**任何**备份/导出/云快照永久失败 | 高 | **主审复核** |
| **F-02** | **P0** | M15 | `src/services/storageAdapter.ts:605-642`（调用点 `:1474`） | **孤儿资源清理不扫 `db.templates`**：只扫 `db.blocks`（`:614-626`）与 `db.recordDrafts`（`:627-636`），于是被模板引用的资源会被判为孤儿并 `db.assets.bulkDelete()` **不可逆删除**；删完后 F-01 的断言又会在模板分支（`:180-186`）抛错 | 同一张图片既作为某记录的资源、又被某个模板引用 → 编辑保存该记录 → 清理触发 → 图片被删 → 模板引用悬空 → 此后所有导出失败 | 高 | **主审复核** |
| **F-03** | P1 | M01/M18/M11 | `AiKnowledgeScopePicker.tsx:78,183`、`KnowledgePodcastPage.tsx:179,321,373`、`VoiceRecallWorkspace.tsx:381` | **时区 off-by-one**：用 `new Date().toISOString().slice(0,10)`（UTC）作为「今天」传给 `getAiKnowledgeScopeRecords`（`aiContextService.ts:219-238`），与 `record.date`（本地 `todayISO()`）比较 | 非 UTC 时区（如 UTC+8）本地 00:00–08:00 期间，UTC 日期仍是前一天 → **当天的记录被排除在「最近 N 天」AI 范围之外**，每日复现 | 高 | **主审复核** |
| **F-04** | P1 | M05 | `recordStructureBlocks.ts:172-182` vs `markdownEditor.ts:181-227` | 对照表单元格导出时**不转义 `|`**，解析端只识别 `\|` 转义 → 单元格内容 `a|b` 回解后列错位 | 结构对照表某个单元格含管道符 → 导出 markdown → 再导入 → 表格列错位、内容丢失 | 高 | 子任务 |
| **F-05** | P1 | M05 | `recordContent.ts:326-332` + `markdownEditor.ts:128-174` | 代码块在纯文本抽取时被当普通文本，其内的 `$$` 会被 `mathBlockRule` 识别为公式 → **代码块围栏丢失且内容变异为公式** | 代码块里含 `$$`（如讲 Markdown 或 LaTeX 的记录）→ 导出 → 导入，代码变公式 | 高 | 子任务 |
| **F-06** | P1 | M10 | `teacherPrompt.ts:414-419` vs `contentBoundary.ts:9-12` | 自由主题模式下 `input.topic`（用户文本）被直接拼进 **system 位**（`trusted-instruction`），**未**被 `UNTRUSTED_LEARNING_CONTENT_GUARD` 包裹 | 自由主题填入口写入提示注入文本 → 绕过材料层防护 | 中 | 子任务 |
| **F-07** | P1 | M06/M08 | `orchestrator.ts:839`（对照 `:901-926`） | 验证任务 ID 用 `this.dependencies.ids.next()`（非确定性），与 `AGENTS.md` 「两台设备产生相同 sync hash」不变量**部分冲突**（队列时间戳是确定性的，实体 id 不是） | 两台设备同时执行延迟验证排程 → 派生任务 id 发散 → 潜在重复任务或同步冲突 | 中 | 子任务 |
| **F-08** | P2 | M12 | `ocrJobService.ts:148-152` | OCR 重试定时器是内存 `setTimeout`，App 被杀后任务永久停留在 `ocrStatus: "queued"`，启动时无按 `queued` 重排逻辑 | 触发一次 OCR 重试后退掉 App → 该资源永远显示排队中 | 中 | 子任务 |
| **F-09** | P2 | M11 | `PodcastTtsForegroundService.java:68-69` | 播客 TTS 的 `apiKey` / `apiKeySecondary` 通过 **Intent extra** 传给前台服务，理论上可被 `dumpsys` / 任务快照读取 | 生成播客期间取系统任务快照 | 中 | 子任务 |
| **F-10** | P2 | M20 | `UiV2PrototypeApp.tsx:102-105`、`VoiceRecallPrototypeApp.tsx:40-43` | 这两个预览壳的守卫**只判断 hostname 是否为 localhost**，缺 `!isNativePlatform() && !isDesktop()`。Capacitor Android 的 WebView hostname 正是 `localhost` | 原生壳内导航到 `/?preview=ui-v2`（需深链入口）→ 渲染原型壳 | 高 | **主审复核** |
| **F-11** | P2 | M21 | `NativeOcrPlugin.java:68-133,172-179`；`NativeAiPlugin.java:204-208`；`NativeZipArchivePlugin.java:138-158` | 三处资源释放不一致：① OCR 请求**从不** `disconnect()`；② `NativeAiPlugin.chat` 的 `finally` 仅在 `cancellationId` 非空时清理，默认路径连接泄漏；③ `finishExport` 异常路径未关 zip 流且未删临时文件，且 session 已从 map 移除 → 永久残留 | OCR 连发多次 / 默认参数调用 chat / 导出中途失败 | 中 | 子任务 |
| **F-12** | P2 | M14 | `learningStats.ts:51` | 删除记录后其 `RecordReviewStats` 仍被聚合进 `dueCount` / `overdue` / `streak` → 「幽灵复习量」 | 删除一条有复习历史的记录 → 统计页数字仍含它 | 中 | 子任务 |
| **F-13** | P2 | M01/M04 | `storageAdapter.ts:973-981`、`repository.ts:588-589` | 草稿与记录的 `put` 均无 `updatedAt` 乐观锁比较 → 多标签页 last-writer-wins，后保存者静默覆盖先保存者 | 两个标签页同时编辑同一记录 | 中 | 子任务 |
| **F-14** | P2 | M13 | `lib/search.ts:104-255` | 全表线性扫描无索引，记录达万级时 O(N·M) | 大量记录时执行全文搜索 | 高 | 子任务 |
| **F-15** | P2 | M09 | `lib/aiProviders.ts:19-56` | `switch (builtIn)` **无 `default` 分支**，未知 `builtIn` 返回 `undefined` → 调用方展开时崩溃（当前内置值均被覆盖，属潜伏缺陷） | 任何未来新增或历史遗留的非内置 provider 标识进入该函数 | 中 | 子任务 |
| **F-16** | P3 | M15 | `nativeFileWriter.ts:129-135` + `knowledgeExportService.ts:148-168` | 分享缓存临时文件**成功路径不删除**（只 `deleteFile` on error）→ `shared-exports/` 在 Cache 中无限累积 | 反复分享导出/知识导出 | 中 | 子任务 |
| **F-17** | P3 | M15 | `backup.ts:19-76` | ZIP / 手动导出路径只以 `generateAsync` 成功即判定成功，**无写后完整性校验**（而原生仓库备份路径 `nativeRepositoryBackupService.ts:307,463-468` 有校验）→ 损坏 zip 可能被判成功 | 磁盘写入不完整 / 中断边缘 | 中 | 子任务 |
| **F-18** | P3 | M04 | `RecordEditorPage.tsx:302` | 草稿保存队列用 `.catch(() => undefined)` 静默吞错，持久化持续失败时用户无感知 | 存储配额耗尽 / IndexedDB 异常 | 中 | 子任务 |
| **F-19** | P3 | M12 | `ocrService.ts:136-213` | `runPaddleOcrViaBrowserFetch` 是一份可用的浏览器直连 OCR 实现，但**全仓零调用**；实际入口 `runPaddleOcr`（`:109-133`）在 native/desktop 均不可用时直接抛错 → 能力被锁死为「需代理」 | 不适用（DEAD） | 高 | 子任务 |
| **F-20** | P3 | M07 | `src/features/reviewAnnotations/generation.test.ts` | **孤儿测试**：被测源文件 `generation.ts` **不存在** | 不适用 | 高 | 子任务 |
| **F-21** | P3 | M19 | `styles/pages.css:458-558` | `.review-evaluation-panel/-toggle/-body/-state/-history` 全套样式已无任何 TSX 使用（**注意**：`legacy-` 前缀的那套 `:3605+` 仍被 `ReviewPage.tsx:1223` 使用，**只可删非 legacy 的**） | 不适用 | 中 | 子任务 |
| **F-22** | P3 | M23 | `package.json` | 死依赖：`recharts`（src 内 0 import）、`idb-keyval`（0 import）；`prosemirror-history` 0 直接 import（疑为 tiptap 传递依赖，**须先核实**） | 不适用 | 中 | 子任务 |
| **F-23** | P3 | M23 | `AGENTS.md:88` | 测试基线数字偏旧：声称 163 文件 / 1021 项，实测 **162 / 1011** | 不适用 | 高 | **主审复核** |
| **F-24** | P3 | M07 | `ReviewAnnotationSurface.tsx:46`（由 `ReviewPage.test.tsx` 触发） | **32 条 `not wrapped in act(...)` 警告**，两次运行均可复现；属测试卫生问题，非产品 Bug | 运行单测 | 高 | **主审复核** |
| **F-25** | P3 | M21 | `NativeVoiceCapturePlugin.java:25/47`；`NativeZipArchivePlugin.java:55-76` | 桥契约小不一致：① Java 发出 `focusLost` 事件但 TS 接口未声明（无害）；② `beginExport` 忽略 TS 传入的 `destination` / `mimeType`，只读 `fileName` 写 `shared-exports` 缓存 | 不适用 | 中 | 子任务 |
| **F-26** | P3 | M11 | `ttsProviders.ts:29/38` → `ttsFallbackAdapters.ts` | `region` / `languageCode` 在非 fish/doubao 的 TTS 适配器里**未被消费**——设置项写入了但不影响请求（疑似死字段） | 在 TTS 设置填写 region/languageCode（非 fish/doubao） | 中 | 子任务 |
| **F-27** | P3 | M23 | `tsconfig.app.json` | 类型检查只覆盖 `src`；`desktop/`、`e2e/`、`scripts/`、`functions/` **不在 `tsc -b` 覆盖范围**，这些目录的类型错误不会被 gate 住 | 不适用 | 中 | 子任务 |
| **F-28** | P3 | M09 | `lib/aiProviders.ts:26` | 种子模型名 `deepseek-v4-pro` 无法静态核实其真实存在性；若无效则开箱即用的 AI 请求直接 404（属配置默认值，归为 MISLEADING 候选） | 使用默认 provider 配置直接发起 AI 请求 | 低 | 子任务 |
| **F-29** | P3 | M23 | `storageAdapter.restore.test.ts`、`storageAdapter.review.test.ts`（最慢用例 `2976ms` / `2926ms`，默认超时 5000ms） | **测试对并发负载敏感**：余量仅约 1.5–2 秒，机器高负载（CI 并发、多个 vitest 同时运行）时会假失败为超时。本次审计已实际踩到一次（见 §0） | 与其他重负载进程并行运行单测 | 高 | **主审复核** |

---

## 5. 模块详细报告（要点摘录）

完整模块级细节见本次六路审计原始输出；此处只保留各模块**非问题总表**内的结构性结论。

### M01 启动 / 全局架构 / 路由
`App.tsx`（1821 行）与 `useAppData.ts`（1086 行）为枢纽。已验证：`App.tsx:169-204,683-730` 的 timer / eventListener 卸载清理成对；`useAppData.ts:84-224` 的 AbortController 集合成对 abort/clear。未全读全部 effect，`refresh()` 与并发写之间的 stale snapshot 风险**未完全排除**，列为需后续跟进项。

### M02 数据层 / 迁移 / schema
`database.ts:323-332` 的 v16→17、v18→19 升级在 Dexie 事务内执行，中断回滚、重跑幂等。`reviewCoachSchema.ts:141-146`（固定 id `put`）、`:148-187`（`clear` + `bulkPut` 确认数据）均幂等。`decisionBlockArchives` 的 `&idempotencyKey`（`reviewCoachSchema.ts:51`）保证归档幂等插入。**M02 内无问题。**

### M03 日志 / 记录 / 今日
`record.date` 来自 `useAppData.ts:728` 的本地 `todayISO()`，与「应本地」语义一致。`searchRecordTitlesAsync` 做了 `deletedAt` 防御。**M03 内无 P0–P2。**

### M04 编辑器 / 富文本 / 结构块
IME 安全范式正确：`markdownInputRules.ts:127-135,280-304` 在 `compositionend`/`input` 用 `scheduled` 标志 + `view.composing` 守卫。`markdownPasteWork.ts:125-247` 有分块/流式/超长 `retainRaw` 处理。`trailingEditableParagraph.ts:130-167,254-267` 在每个 `docChanged` 事务补齐尾部空段，undo 时 `removeRestoredAutomaticParagraphs` 只删 auto 段。结构/对照/便签/折叠/高亮/决策节点渲染**只依赖属性**（`data-json`/`data-source`/`data-title`），与抽取逻辑一致。资源生命周期成对（`RichTextEditor.tsx:1065-1524`、`RecordStructureNodes.tsx:417`、`RecordHighlightBlockNode.tsx:84-87`）。

### M05 Markdown / 序列化
**H26 不成立**：公式双计修复完整，其它节点无同类重复抽取。证据：`recordContent.ts:56-58` 公式原地渲染；`collapseElementText`（`:194-217`）对结构块只经 `querySelectorAll` 取一次 `data-json`（`recordStructureBlocks.ts:204-224`）；mermaid 数据存于 `data-source` 属性（`RecordStructureNodes.tsx:937-938`）而非 innerHTML，`stripHtml` 不会重复计入；决策块经 `parseLinearRecordContent` 递归一次（`:260-262`）。但往返无损性有 F-04、F-05。

### M06 / M08 复习 / Coach
**H19 不成立**：全仓 grep 确认无绕过 `repository.ts` 的 Coach 表写入（`storageAdapter.ts:1884` 的 `db.decisionBlocks.bulkPut` 位于记录转移导入事务内 `:1840-1895`，非越权）。**H20 成立**：orchestrator 全部经 `this.dependencies.repository`，`useAppData.ts` 仅构造与调用。**H21 成立**：`rebuildReviewCoachProjectionsInTransaction`（`repository.ts:411-435`）只读 `getReviewCoachFormalSnapshot`，在 `formalTables` 同一事务内被调用（`:502,525,1304`）。**H22 成立**：`voiceRecall/**` 无 `fsrs`/`rateRecord` 写入。`bumpMutation()`（`repository.ts:474-477`）在所有正式写后标记云变更；`staleDerivedWork`（`:479-493`）在内容版本变更时正确作废派生工作。

### M07 复习批注（本次最干净模块）
`repository.ts:16-53` 全部直写 `db.reviewAnnotationDrafts` 且不调 `markCloudSyncMutation`。`storageAdapter.ts:1909-1927`（云）与 `:1984`（备份/导出）的 store 列表均不含该表；`restoreSnapshotData` 仅 `clear()` 不 `bulkPut`。`clearAfterRating`（`repository.ts:42-52`）写 `pendingClear:true` + `writeGeneration+1`；`upsertDraft`（`:34`）在 `pendingClear` 或 `writeGeneration` 不匹配时拒绝写入——250ms 防抖与卸载兜底两条路径都受该守卫保护。撤销后 `clearAfterRating` 清空 `elements`/`history`（`:20-29`），旧批注不恢复。**M07 专项四项全部成立。**

### M09 AI 能力
**H31 成立**：`aiRetry.ts` 在 `signal?.aborted` 时 reject；`orchestrator.ts:359` 仅对 `AiRequestError.retryable` 重试；`aiClientService.ts:331-438` fetch 全程透传 signal。**H32 成立（无溢出）**：`retrievalTokens = Math.min(retrievalTargetTokens, Math.max(0, available))`（`aiClientService.ts:194`），`available` 已扣减 output/system/history/summary/prompt；当 `retrievalTokens < MIN_AI_RETRIEVAL_TOKENS(2000)` 时**直接抛出**（`:195-196`）而非下探。**H33 不成立**：AI 聊天**无流式**（仅 voiceRecall 与备份有 stream），`AiChatPage.tsx:510-528` 等完整响应才存库，中断仅丢弃不写半截。

> 注意：`aiClientService.ts:184-195` 的 `retrievalTokens = min(固定常量 16000/24000, 剩余)` 结构**仍在**——即模型窗口大小对检索预算**不生效**（32k 与 128k 结果相同）。这是 `STUDYJOURNAL_VOICE_CONTEXT_TRUNCATION_FIX_PLAN.md` 中 R4 记录的问题；语音链路已在 2026-09-14 修复，**AI 问答链路未修**。属已知取舍，故未列入问题总表，但收口前应明确它是有意保留还是遗漏。

### M10 语音复述（H1 数据边界——本次最重要的负面确认）
**H1 成立且干净**：三张本机表仅在 `database.ts`、`reviewCoachSchema.ts`、`repository.ts`、`storageAdapter.ts` 被引用；对所有序列化/导出/同步服务的 grep 命中为 **0**。快照走显式表枚举：`storageAdapter.ts:1984`（事务表清单）、`:1986-2000`（读取清单）、`:2001`（返回对象）均不含三表；`createStreamableSnapshot`（`:1981-2050`）同源排除；还原侧 `:2127` 的 `clearLocalVoiceRecallTransient` 仅清空、从不写回。
**H3 / H4 / H5 / H6 / H7 / H10 全部成立**：`userMuted` 与 `systemCaptureGate` 独立（`domain.ts:19-31,92,126-131`）；Android 麦克风双向互斥（`VoiceCaptureController.java:62-63` ↔ `AudioRecordingController.java:30-35`）；音频焦点释放幂等 + `focusEpoch` 链化（`audioFocus.ts:34-40`、`NativeVoiceCapturePlugin.java:31,56-61`）；取消后写库被 `isCurrent()` 双重检查 + 事务回滚拦住（`repository.ts:87-123`）；`max_tokens` 224/250 在所有路径钳制且 reasoning 不入 TTS（`productionPipeline.ts:31-37,143`、`openAiLlmStreamAdapter.ts:50,53,72-74`）；桌面 IPC 通道三方一致、帧类型对称（`main.cjs:562-604` ↔ `preload.cjs:48-57`）。
**H8 / H9 部分成立**：材料走 `untrusted-learning-content`、历史走 `user-utterance`（`teacherPrompt.ts:455,379,390`），但自由主题的 `input.topic` 未加 guard（→ F-06）。
**平台分支可达性成立**：`runtimePlatform.ts:10-18` 的 android/desktop/web 三分支均可达；`:355-362` 的 Web 拦截非直连 profile 是**有意设计**，非死分支。

### M11 TTS / 知识播客
**H37 不成立**：`doubaoTts.ts:2`（V3 NDJSON 解码）与 `:38`（V1 小模型 JSON）**两路都活着**（`knowledgePodcastService.ts:760` 调 V1、`:791` 调 V3；`PodcastTtsForegroundService.java:437-505` 同时处理 `volcano_tts` 与 `seed-tts-2.0`）；`nativeTts.ts`（单请求，语音复述用）与 `nativePodcastTts.ts`（批量前台，播客用）职责不同，**非重复实现**。
前台服务健壮：取消时单元置回 `pending`（不残留失败行，`:289`），`finally` 必 `stopForeground` + `stopSelf`（`:308-313`），`onDestroy` 仍运行则 `markInterrupted`（`:200-211`），`NativePodcastTtsPlugin.java:94-97` cancel 发取消 Intent。
浏览器自动播放策略**满足**：`MediaPlaybackService.java:211-212` 恢复后 `player.pause()`（不自动播），`mediaPlaybackService.ts:83-168` 的 `preparePlaybackSession` 仅落盘不 `play()`。
Web 诊断脱敏完整：`providerRuntime.ts:53-60`（`redactVoiceDiagnostic`）对 bearer/apikey/token/URL 脱敏。

### M12 OCR
Web 端为**诚实报错**（`ocrService.ts:133` 直接 throw），不是静默假成功——但存在 F-19 的死代码（浏览器直连实现零调用，能力被锁死为「需代理」）。重试失败路径 `finishJobWithError` 正确写 `ocrStatus:"failed"` 并 `finalizeJob` 清理。`prepareJob` 对不存在/非图片资产安全解析。

### M15 备份 / 恢复 / 导出
四条导出通道（ZIP `backup.ts:25-26`、流式 `streamingBackupService.ts:52`、原生仓库 `nativeRepositoryBackupService.ts:282`、autoBackup `autoBackupAdapter`）**全部**调用隐私剥离——这是正面结论。中断均 `cancelExport` / `cancelNativeRepositoryFileWrite` 清理半成品（`:110,:124`）。`autoBackupService.ts:177-182` 的 debounce 定时器被杀时会丢，但 `onAppBackgroundAutoBackup` + 启动 `flushAutoBackupNow("app-start")` 兜底，模块级 `runningPromise` 防重入（`:87-200`）。

### M16 云同步（H12–H16 全部成立）
`cloudSyncModel.ts` 为**整对象序列化**（`mapEntities`，`:325-330`），新增字段自动入映射，**无字段级 allowlist，因此不存在漏映射丢数据**。唯一被剥离的是 `settings.ai` / `settings.tts` / `lastBackupAt` / `syncFolderName` / `knowledgePodcastModeTemplates`（设备本地，`exportPrivacy.ts:24-37`），属**有意设计**。
**H13 成立**：全仓无 `deleteDoc(reviewEventsRef)`，review-event 仅 `addDoc`/`setDoc` 写入。**H14 成立**：`canSkipCloudSyncLock`（`:866-875`）仅在「无本地改动且远端未前进」时为真；`cloudSyncWriteRequiresConfirmation`（`:904-909`）在 `estimatedWrites ≥ 5000 || 对象 ≥ 500 || 字节 ≥ 100MB` 时强制确认，阈值不可绕过（估算 = 实际变更数）。**H16 成立**：四个边界的隐私剥离一致。**H15 成立**：`restoreSnapshotData` 清空语音临时会话/轮次但保留本机历史、清 `reviewAnnotationDrafts`；云同步三表全保留 + `preserveLocalSettings/preservePodcasts`（`:2152-2162`）。
`cloudSyncStore.ts` 的本地锁有 6 分钟 watchdog（`:38,86-96`）+ `visibilitychange` 自愈（`:161-178`），异常退出**不会永久卡死**。
`firestore.rules:4-6` / `storage.rules:4-6` 对 `users/{uid}/**` 整体 `uid == userId` 放行，覆盖 entities / syncReviewEvents / snapshots / lock；`functions/src/index.ts:15-35` 的 `getStorageUsage` 用 `context.auth.uid` 前缀，返回字段与 `firebaseStorageUsageService.ts:24-42` 的校验一致。

### M17 媒体 / 附件
作用域内 `createObjectURL` / `revokeObjectURL` / `new Audio` / `AbortController` 命中为 **0** → 无手动泄漏。`RecordingsPage.tsx` loading/finally 配对。

### M18 设置中心 / 导航 / 布局
**假接口排查通过**：使用教程 `UsageGuidePage.tsx` 引用的每条入口（更多 → AI 问答 / 知识播客 / OCR 设置 / 录音库 / 模板 / 统计 / 备份与恢复 / 设置）均真实存在于 `MorePage.tsx:78,86,93,105,106,107,125,131`；「日志互通」= `BackupPage.tsx:371`；「收藏」= `FavoritesPage.tsx`；复习入口 = 真实学习助教工作区。
**H44 不成立**：Dexie 在 `open` 时按 schema 版本自动前向迁移（v1→v21），与 service worker 无关；`vite.config.ts:9` 的 PWA `autoUpdate` + `nativeServiceWorker.ts:23-53`（原生端 unregister SW + sessionStorage 防重载循环）兜底。残留仅 Web PWA 升级瞬时可能短暂服务旧 shell，但 DB 迁移前向安全。
`visualTheme` 存 localStorage、设备本地，不进同步（符合边界）。`platform.ts` / `clipboard.ts` / `format.ts` / `dailyMotto.ts` / `subjects.ts` / `entity.ts` 为纯函数无副作用。

### M19 视觉层
`main.tsx:12-18` 的导入顺序让 `visual-v2.css` 最后胜出；`theme.css:1-59` 与 `visual-v2.css:1-54` 都在 `:root` / `[data-theme=dark]` 定义同名自定义属性，visual-v2 级联胜出——**是有意设计**（`reading` 为默认 serif，`modern` 走 `[data-visual-theme=modern]`）。`src/styles/*.test.ts` 五个文件实为「源码文本断言」（`readFileSync` + `toContain`），**不是渲染行为测试**——属测试质量债，不计为 Bug。

### M20 预览壳
`?preview=` 全枚举共 **10 个取值**：`voice-recall-production`、`voice-recall-policy`、`voice-recall`、`ui-v2`、`stage3`～`stage7`、`coach`、`journal-performance`。其中 `stage3`~`stage7` / `coach` / `journal-performance` 守卫正确（`!native && !desktop && localhost`，`stage3PreviewSeed.ts:597-651`）；`voice-recall-production` / `voice-recall-policy` 守卫正确（`App.tsx:112-118`）；**`ui-v2` 与 `voice-recall` 缺原生壳排除**（→ F-10）。三个预览壳**均仍被使用**，无冗余壳。

### M21 / M22 宿主
**H41**：11 个 Plugin 的方法名 / 参数键 / Listener 名**全部对齐**，仅 2 处无害小不一致（→ F-25）。`NativeVoiceAsr`、`NativeTts`、`NativeFirebaseStorage`、`NativeAutoBackup` 释放规范（`NativeTtsPlugin.java:26-39` 的 `RequestState` 跟踪并关闭所有连接）。
**H43**：`desktop/preload.cjs` 暴露的每个 `invoke` 都有对应 `ipcMain.handle`，每个 `ipcRenderer.on` 都有对应 `webContents.send`，**无孤儿通道**（`main.cjs:547-943`）；`package.json:113-147` 的 `files` 含 `installer.nsh` 与 `icon`，无遗漏。
**H42 不成立**：全仓无 iOS 专属配置（`capacitor.config.ts` 仅 `androidScheme`）。

### M23 构建 / 测试基础设施
`patches/prosemirror-history+1.5.0.patch` 为有意修改（`DEPTH_OVERFLOW=0` + 编辑器重置历史 meta），**仍必要**。e2e 13 个 spec 抽样 9 个（含 stage9 / journal-performance / ui-v2 系列 / voice-recall 系列）：断言均为**强断言**（`errors` 空数组校验、命中测试、几何重叠、computed style），无弱断言、无互相依赖。

---

## 6. 接口真实性矩阵（汇总）

分类结果：**`FAKE: 0` / `REGRESSED: 0` / `DEAD: 6` / `MISLEADING: 2（候选）`**，其余为 `REAL` 或 `CONDITIONAL`。

### `DEAD`（6 条，均可安全清理）

| 接口 | 位置 | 引用计数 |
|---|---|---|
| `runPaddleOcrViaBrowserFetch` | `src/services/ocrService.ts:136` | 0（仅声明行） |
| `SiliconFlowBatchAsrAdapter` | `src/features/voiceRecall/siliconFlowBatchAsr.ts` | 1（仅其自身测试） |
| `createVoiceLlmProfile` | `src/features/voiceRecall/providerProfiles.ts:325` | 1（仅 `androidLlmStream.test.ts`） |
| `generation.test.ts`（孤儿测试） | `src/features/reviewAnnotations/` | 被测源文件不存在 |
| `.review-evaluation-*`（非 legacy 前缀） | `src/styles/pages.css:458-558` | 0 |
| `recharts` / `idb-keyval`（死依赖） | `package.json` | src 内 0 import |

### `MISLEADING`（2 条候选，均需人工核实）

| 接口 | 位置 | 说明 |
|---|---|---|
| 种子模型名 `deepseek-v4-pro` | `src/lib/aiProviders.ts:26` | 无法静态核实该模型是否真实存在；若无效则默认配置开箱即失败 |
| TTS `region` / `languageCode` | `src/lib/ttsProviders.ts:29/38` | 设置项写入了，但非 fish/doubao 适配器未消费 → 填了不生效 |

### `CONDITIONAL`（真实但受平台/配置守卫，**不是清理项**）

- 语音 Web 端非 `browserDirectSupported` 的 profile（`assertBrowserDirectSupported` 在 Web 抛错，已显式披露）
- Firebase Storage 用量查询（仅云同步开启时触达，`CloudSyncPanel.tsx:20/21`）
- 全部 `?preview=` 原型路由
- ASR `asrOptions.*`（仅 aliyun-bailian 分支真正消费）
- `voice-default-cn@2` 及豆包各 profile（`candidate` 状态，AGENTS 已声明）

### `REAL`（抽查确认，非穷举）

Coach 三网关（`useAppData.ts:50,54,55` 接入）、`ttsProviders`、`doubaoTts` 双解码器、`nativeTts` / `nativePodcastTts`、语音 ASR/LLM/TTS 适配器工厂（`providerFactory.ts:11/22/35`）、OCR token 读写闭环（`OcrSettingsPage.tsx:11` → `ocrService.ts:108`）、ASR 凭据（`VoiceAsrCredentialSettings.tsx:34` → `credentials.ts`）、`asrOptions` / `ttsAppId` → `productionPipeline.ts:80,93`、Firebase `getStorageUsage`（云函数 + 前端 callable 闭环）。

---

## 7. 死代码与废弃资产清单

见 §6 `DEAD` 表。补充说明：

- **`legacy-review-evaluation-history`（`pages.css:3605+`）与 `review-evaluation-*`（`:458+`）是两套不同的类名**，前者被 `ReviewPage.tsx:1223` 使用，**只可删非 legacy 的那套**。这是本清单里最容易被误删的一项。
- `prosemirror-history` 在 src 内 0 直接 import，可能是 tiptap 的传递依赖，**删除前必须先核实**（`patches/prosemirror-history+1.5.0.patch` 的存在进一步说明它可能是传递依赖）。
- 旧 schema 迁移分支（≤16）**不可删**——它是数据回滚保障，属于「看起来像死代码但不能删」。
- `SiliconFlowBatchAsrAdapter` 虽属 DEAD，但 AGENTS.md 已声明 SiliconFlow 实时 ASR 为「未实现」，删除它等于放弃未来接入的起点，**建议保留并加注释说明**而非删除。

### 高危清理项（看似死代码但**不能删**）

`storageAdapter.ts` 的全部 public 方法（本地持久化的唯一真相源，被 80+ 出口与四条备份通道依赖）、`useAppData.ts` 的导出集合与 `App.tsx` 导航状态（中心广播器）、`aiSecrets` 表读写（四类密钥共用）、`markSourceUnavailable` 调用族（`useAppData.ts:292-330`，删除/恢复/清理的数据生命周期补偿）、`cloudSyncModel.ts` / `cloudSyncService.ts`。

### 重复实现（**不建议本次统一**）

| 组 | 位置 | 统一风险 |
|---|---|---|
| 语音 TTS | `nativeTts.ts`（复述） vs `nativePodcastTts.ts`（播客） | 中（两条腿状态/生命周期不同） |
| Markdown 渲染链 | `markdown-it`（编辑器/公式） vs `react-markdown`（`AiMarkdown`） | **高**（Tiptap 序列化 vs React 渲染，强行统一会破坏编辑器） |
| TTS Profile | `ttsProviders.ts` vs `providerProfiles.ts` | **高**（设置态与运行时态分两套） |
| 备份四通道 | ZIP / streaming / native repository / autoBackup | **高**（四通道共担 F-01/F-02 缺陷，统一需谨慎） |

---

## 8. 回归对账（git 驱动）

对 12 个近期提交逐个体检 6 类静默回归：

| 提交 | 结论 |
|---|---|
| `b20aa7f` voice natural conversation | 不成立（删 `dialoguePolicy.ts`/`teacherProtocol.ts` 后全仓 grep 无残留调用方） |
| `829f98d` AI/TTS device-local | 不成立（键串 `ai`/`tts`/`lastBackupAt`/`syncFolderName` 均未改名；剥离是预期行为） |
| `a1fd43e` replay/verification 边界 | 不成立（`replay.ts` 的版本守卫是正确边界，非死路） |
| `f92b2dd` teaching strategy | 不成立（纯新增，且已被 `b20aa7f` 一并清理） |
| `306e9bb` AI chat context | 不成立（`App.tsx` 仅加 import，无路由/query 改动） |
| `4280bb5` mobile toolbar | 不成立（仅 CSS + 布局） |
| `9cd502f` Android asset sync | 不成立（仅脚本，无 `src/` 功能代码） |
| `de4e716` provider selectable | 不成立（`providerProfiles.ts:288-301` 用 `typeof === "string"` 向后兼容；新增 profile id 为全新唯一值，旧 id 未改） |
| `eb198aa` review motion | 不成立（`webNavigationHistory.ts:303-318` 的 `navigationIndex` 缺省回 `0`，向后兼容） |
| `2f52782` repair prod modes | 不成立，但**注意**：语音默认输入由 `tap-to-record` 翻转为 `auto-half-duplex`（`VoiceRecallWorkspace.tsx:188,247`），VAD 阈值下调至 `0.006/0.008`。**已文档化的产品变更，非静默失效** |
| `0c1adb1` usage guide 重构 | 不成立（`UsageGuidePage.tsx:56,242` 全为页内锚点，无假路由） |
| `0d70d55` README 精简 | 不成立（纯文档） |

**结论：12/12 未发现成立的静默回归。** 4 类高危静默回归（导出改名、持久化键改名无迁移、路由/query 改名、设置项改名导致凭据失配）全部不成立。

---

## 9. 文档 vs 代码对账

| 文档声明 | 位置 | 代码事实 | 一致 | 处置 |
|---|---|---|---|---|
| 163 个 Vitest 文件 / 1021 项测试 | `AGENTS.md:88` | 实测 **162 文件 / 1011 项**（两次复现） | ❌ | 更新为 162 / 1011（→ F-23） |
| 54 个 Playwright 用例 | `AGENTS.md:88` | 54 collected（49 passed / 1 skipped / 4 沙箱收尾报错） | ⚠️ | 数量吻合；建议注明 4 项为环境限制 |
| 142 文件 / 920 项 | `second-audit-repair-acceptance.md:45` | 该文自注「最终计数以最后一轮实际输出为准」 | ⚠️ | 已被 AGENTS 覆盖，无需改 |
| 语音/批注不进云、备份、导出 | `README.md:85-86`、`AGENTS.md:28-29` | `storageAdapter.ts:1909-1927`（云）与 `:1984`（备份/导出）store 列表均不含 `voiceRecall*` / `reviewAnnotationDrafts` | ✅ | — |
| API 密钥不随备份/同步迁移 | `README.md:84` | `exportPrivacy.ts:24-39` 剔除 `ai`/`tts`；`sanitizeSettingsForExport` 被 `cloudSyncModel.ts:94,568` / `backup.ts:25` 调用 | ✅ | — |
| 间隔复习 FSRS / 只读批注 | `README.md:38-40` | FSRS 调度 + `ReviewAnnotationSurface`（只读包裹）存在 | ✅ | — |
| schema 21 / 半双工 / provider 可选 | `CHANGELOG[Unreleased]` | 与 `reviewCoachSchema.ts`、`2f52782`、`de4e716` 一致 | ✅ | — |
| 使用教程仅描述已实现能力 | `AGENTS.md:17` | `UsageGuidePage` 的入口全部真实存在 | ✅ | — |

**未发现的三类问题**：① 声称已实现但代码里没有（0 条）；② 代码里有但文档说没有（0 条）；③ 参数/默认值/模型名不一致（0 条，`voice-default-cn@2` 与 Aliyun/DeepSeek/Fish 命名一致）。

**唯一硬偏差是测试计数（F-23）。**

---

## 10. 跨切面不变量反例搜索（10 条）

| # | 不变量 | 结论 | 证据 / 搜索方法 | 置信度 |
|---|---|---|---|---|
| 1 | React 渲染错误必经 `uiError.ts` | **未发现反例** | 全仓 `error.message` 于 `*.tsx` 仅 `PlaybackProvider.tsx:160-164`（在 catch 中包裹后 rethrow，非渲染）；`productionPipeline.ts:49` 用 `formatUiError`；`uiErrorSurface.test.ts` 守门 | 高 |
| 2 | `contentHtml` 唯一真相源 | **未发现反例** | `DecisionBlock` 为索引，无 `contentHtml` 字段（`repository.ts:608-616`）；`contentHtml` 仅存于 `decisionBlockArchives` 作为可恢复快照（`repository.ts:642`） | 高 |
| 3 | AI 响应/缓存非真相源 | **未发现反例** | 导出层 `stripPrivateExportFields` 剥离 prompt / rawResponse（`exportPrivacy.ts:15-20`） | 中 |
| 4 | 决策块不静默改写 FSRS | **未发现反例** | FSRS 由 `recordReviews` 独立调度；决策块事实走 `repository.ts` | 中 |
| 5 | 云端 event append-only | **未发现反例** | `cloudSyncService` 无远程 event 删除路径（grep 无 `deleteDoc(reviewEventsRef)`） | 高 |
| 6 | 批注写入不标云变更 | **未发现反例** | `reviewAnnotationDrafts` 写入处 grep `mark\|cloud\|mutat\|change` 无匹配 | 高 |
| 7 | 语音/批注不进云/备份/导出 | **未发现反例（已强制执行）** | `storageAdapter.ts:1909`（云）与 `:1984`（备份/导出）store 列表 | 高 |
| 8 | 语音不写 FSRS / 不自动评分 | **未发现反例** | `voiceRecall/*.ts`（非 test）grep `submitQuizAnswer\|fsrs\|rateReview\|autoRating` 无匹配 | 高 |
| 9 | 普通校验排除 live 测试 | **未发现反例** | 仅 2 个 live 文件（`aliyunAsrTransport.live.test.ts`、`voicePipeline.live.test.ts`），无密钥自动跳过；验证命令显式 `--exclude "**/*.live.test.ts"` | 高 |
| 10 | 密钥不入源码/测试/文档/日志 | **见下方专门说明** | 全仓正则（排除 node_modules）命中 1 处 | — |

### 关于第 10 条的专门说明（重要，勿误读）

`src/services/firebase.ts:10` 含一条**真实的 Firebase Web API Key**（`AIzaSy...`，project `study-journal-408-9f31`），并随构建产物扩散到 `dist/`、`android/app/src/main/assets/public/`（即随 APK 发布）。

**但这不是一次凭据泄露。** 该文件 `:7-8` 的注释已明确说明其性质：

> `// Firebase web configuration values identify this public client. They are not`
> `// service-account credentials and are protected by Authentication and Rules.`

Firebase Web API Key **设计上就是公开的**（每个 Firebase Web 应用都会把它打进前端产物），真正的访问控制由 Security Rules 完成——本次审计已确认 `firestore.rules` / `storage.rules` 对 `users/{uid}/**` 做了 `uid == userId` 隔离。

**它构成的问题是「文档与代码的措辞冲突」，而非安全事件**：`AGENTS.md:61` 写着「never persist API keys in source, tests, docs, logs, screenshots, backup, or sync data」，字面与现状冲突。建议二选一：① 在 `AGENTS.md` 明确「Firebase Web 配置视为公开客户端标识，不适用该条款」；② 若坚持严格口径，改为构建期注入环境变量。

**LLM 密钥（`sk-` 等）在源码、测试、文档中均未发现。** 真实付费 Provider 的密钥保持设备本地（`credentials.ts`、`aiSecrets` 表），未被纳入版本控制。

---

## 11. 高风险无测试清单

| 模块 | 无测试的高风险物 | 风险说明 |
|---|---|---|
| M06 | `ReviewPage.tsx`、`reviewSession/runtime.ts`、`PlaybackProvider.tsx`、`DeferredMath.tsx`、`RecordCard.tsx` | **全部无对应 `.test.ts`**；复习是核心闭环 |
| M07 | `ReviewAnnotationSurface.tsx` 无组件测试 | 并发守卫逻辑自洽但无回归保护；且唯一的 `generation.test.ts` 还是孤儿（F-20） |
| M08 | `orchestrator.ts`（82KB）仅部分路径被覆盖；`useAppData.ts` 无专项测试 | 枢纽文件、改动波及面最大 |
| M09 | `AiChatPage.tsx`、`AiToolsPage.tsx`、`AiExportPage.tsx`、`AiMarkdown.tsx`、`AiKnowledgeScopePicker.tsx`、`aiChatAttachmentService.ts`、`aiSessionService.ts` | AI 交互层几乎无测试 |
| M10 | 取消后写库回滚（`repository.ts:87-123` 的 `isCurrent` 竞态）无专项测试 | 已确认逻辑正确，但缺回归护栏 |
| M12 | `ocrJobService` 的重试/取消幂等 | 无 cancel API，仅靠 `prepareJob` 兜底 |
| M15 | `importRestoreService` / `recordTransferService` 的跨表事务恢复 | 数据恢复路径，失败后果最严重 |
| M16 | `cloudSyncStore` 异常退出后的锁自愈 | 有 watchdog，但无异常退出单测 |
| M18 | `popoverPosition.ts` / `layoutOverflow.ts` / `viewport.ts` 在 Android insets 下的行为 | 真机未验 |
| M19 | 五个 `src/styles/*.test.ts` 是**源码文本断言**，非渲染测试 | 样式回归实际无护栏 |
| M23 | `desktop/`、`e2e/`、`scripts/`、`functions/` 不在 `tsc -b` 覆盖内（F-27） | 宿主与云函数类型错误不会被 gate |

---

## 12. 无法静态验证清单（需人工 / 真机 / 真账号）

1. **F-07 的真实影响**：验证任务 id 跨设备发散是否真的会导致同步冲突——需两台设备（或两个 profile）实操延迟验证排程。
2. **F-09 / F-11 的 Android 行为**：需真机 + `dumpsys` 才能确认 apiKey 暴露面；需长时运行才能观察连接泄漏累积。
3. **F-10 的触发条件**：需在 Android 壳内构造深链 `/?preview=ui-v2`，确认是否能到达 WebView。
4. **F-12 幽灵复习量的用户可见性**：需在真机删除记录后核对统计页数字。
5. **IME 组合态行为**（`markdownInputRules.ts` 的 `compositionend` 在 Android 上的实际触发顺序）——AGENTS.md 明确列为手动发布门禁。
6. **doubao / Fish Audio / SiliconFlow 各 profile 的真实可用性**——AGENTS.md 已声明为 `candidate`，需激活的真实账号验证。
7. **Firebase 真实账号配额签署**——AGENTS.md 已列为发布门禁。
8. **`?preview=` 原型视觉在三端的实际渲染**（本次仅静态核对守卫逻辑）。
9. **`docs/knowledge-base-evolution-blueprint.md`** 的规划内容是否与既定产品边界冲突——属产品决策，非代码问题。
10. **F-28 的模型名 `deepseek-v4-pro` 是否真实存在**——需联网核实。

---

## 13. 已验证干净清单（负面确认）

以下曾怀疑但**经核实不成立**，明确排除，避免收口阶段重复排查：

| 曾怀疑 | 结论 | 依据 |
|---|---|---|
| 语音三表 / 批注草稿泄漏进云同步或导出 | **不成立** | 全路径穷举，见 §5 M10 / M07 |
| 云同步漏映射字段导致静默丢数据（H12） | **不成立** | `cloudSyncModel` 整对象序列化，新增字段自动入映射 |
| 云端 review event 被本地压缩连带删除（H13） | **不成立** | 全仓无远程 event 删除路径 |
| no-op 同步绕过云锁 / 大额写无确认（H14） | **不成立** | 阈值逻辑不可绕过 |
| 导出隐私在某一边界漏剥（H16） | **不成立** | 四边界一致调用 `sanitizeStreamableSnapshotForExport` |
| PWA 升级后 IndexedDB 未迁移导致打不开（H44） | **不成立** | Dexie 前向迁移与 SW 无关 |
| Coach 存在绕过 repository 的越权写入（H19） | **不成立** | grep 全仓，唯一命中是记录转移导入事务 |
| 流式半截消息被持久化（H33） | **不成立** | AI 聊天无流式，等完整响应才存库 |
| 公式在折叠/高亮块内被重复抽取（H26） | **不成立** | 修复完整，其它节点无同类残留 |
| `DecisionBlock` 参与反向写回正文（H27） | **不成立** | 纯索引，无 `contentHtml` 字段 |
| 使用教程含不存在的按钮（假接口） | **不成立** | 逐条核对，入口全部真实 |
| 语音默认模式翻转属静默回归 | **不成立** | `2f52782` 是有意变更且已文档化 |
| iOS 存在死配置资产（H42） | **不成立** | 全仓无 iOS 专属配置 |
| Desktop IPC 存在孤儿通道（H43） | **不成立** | 三向一一对应 |
| Android Plugin 方法名与 TS 调用脱节（H41） | **不成立** | 11 个 Plugin 全部对齐 |
| `nativeTts` 与 `nativePodcastTts` 是重复实现（H37） | **不成立** | 职责不同，非重复 |
| 豆包 TTS V1 路径已成死代码 | **不成立** | V1/V2/V3 三路均活着 |
| e2e 存在弱断言 / 永远为真的断言 | **不成立** | 抽样 9 个 spec 均为强断言 |
| 源码/文档泄漏真实 LLM 密钥 | **不成立** | 仅 Firebase Web 公开配置（见 §10） |
| 12 个近期提交引入静默回归 | **不成立** | 12/12 逐项核实 |
| 语音暂停路径存在非法状态迁移、R11 无法完成 | **不成立** | 并发污染运行导致；单独与干净全量重跑均通过（见 §0） |

---

## 14. 建议的收口行动顺序

按「修复收益 / 回归风险」四象限排序。

### 第一象限：高收益 · 低风险（建议立即修）

1. **F-01 + F-02 备份完整性缺陷** —— 必须最先修，二者是同一链路的因果对（F-02 删资源 → F-01 报错 → 导出永久失败）。
   - F-02 改法：`cleanupOrphanAssetsForRecord` 的资源引用扫描补上 `db.templates`。
   - F-01 改法：二选一并保持语义一致——① 让 `assertSnapshotIntegrity` 接受「被有意排除的资产类别」白名单；② 或改为先过滤正文中的播客引用再断言。**不要简单删掉断言**，它会失去真正的完整性保护。
   - 必须补回归测试：模板引用资源 + 记录引用播客音频 两个场景。
2. **F-23 `AGENTS.md` 测试数字修正**（163/1021 → 162/1011）——一行改动。
3. **F-22 死依赖 + F-19 死代码清理**——`recharts`、`idb-keyval`、`runPaddleOcrViaBrowserFetch`、`createVoiceLlmProfile`。零风险，立即降体积。（`prosemirror-history` 先核实是否传递依赖再动；`SiliconFlowBatchAsrAdapter` 建议保留加注释。）
4. **F-20 / F-21 残留清理**——孤儿测试 `generation.test.ts`、`pages.css` 非 legacy 的 `.review-evaluation-*`。**务必只删非 legacy 那套。**
5. **F-29 测试超时余量**——把两个 `storageAdapter` 慢用例的超时调高（或降低其耗时），否则 CI 在高负载下会持续假失败。

### 第二象限：高收益 · 中风险（建议同批修，需回归测试）

6. **F-03 时区 off-by-one**——散布在 3 个文件 5 处，改法统一：改用 `todayISO()` 或新增本地日期助手。参考 `docs/ai-chat-history-date-audit-2026-09-14.md` 的建议（新增 `isoDateTimeToLocalTime` + 固定 `TZ=Asia/Shanghai` + 加「禁止裸切片日期」护栏）。**注意不要改 `tencentSigning.ts:56`，那里用 UTC 是正确的。**
7. **F-04 / F-05 Markdown 往返损坏**——导出侧补转义（F-04）、纯文本抽取侧保留代码块语义（F-05）。都是局部改动，但需补往返测试。
8. **F-06 自由主题提示注入面**——把 `input.topic` 包进 `user-utterance` 或加 guard 文本。
9. **F-15 `aiProviders` switch 补 `default`**——防御性一行改动。
10. **F-10 预览壳守卫**——加 `!isNativePlatform() && !isDesktop()` 三行代码，低成本防御加固。
11. **F-18 / F-16 静默失败与临时文件残留**——草稿保存失败改为可见提示；分享缓存成功后清理。

### 第三象限：高收益 · 高风险（建议收口后再做，本次不要做）

12. **F-13 乐观锁**——改动触及 `storageAdapter` 与 `repository` 的写路径，波及面大，且需要新的冲突 UI。
13. **F-14 搜索索引**——需 schema 变更（新增索引表），**会触碰 schema 冻结面**。
14. **F-07 验证任务 ID 确定性**——需先确认云同步是否真正依赖该 id；若依赖，改动会触及同步 hash 稳定性。
15. **重复实现的统一**（Markdown 渲染链、TTS Profile、备份四通道）——**明确不建议本次做**。三者都是「看起来很高级、实际会引发大范围回归」的改动。

### 第四象限：低收益 · 低风险（可随手清）

16. F-08（OCR 重试卡 queued）、F-11（Android 连接释放三处）、F-17（ZIP 写后校验）、F-24（act 警告）、F-25（桥契约小不一致）、F-26（TTS 死字段）、F-27（tsconfig 覆盖范围）、F-28（默认模型名核实）。

### 明确的收口建议

- **修完 1、2 两项后即可宣布可进入收口维护阶段**；第 3–5 项建议同批完成（都是低风险、可测试、且直接影响用户可见行为或 CI 稳定性）。
- 第 6–11 项建议在收口前的最后一个特性批里一并处理。
- 第 12–15 项**不应**在收口阶段引入。
- 第 16 项可作为「顺手加固」，不构成收口门槛。

---

## 附：与既有 6 份审计的关系

| 本次发现 | 与既有审计关系 |
|---|---|
| F-01、F-02 | **重复**（`zip-export-failure-diagnosis-2026-09-13.md` R-1/R-3 已记录）——本次独立复核确认**代码未修，问题仍存活**，且本次补充了 F-02 → F-01 的因果链 |
| F-10 | **重复确认**（第二轮 R2-15） |
| F-03 | **部分重叠 + 修正**：已有审计点名 `AiChatPage.tsx` / `recordings.ts`，本次独立复核发现这两处**已无该问题**，真正残留是三文件 5 处 |
| F-04、F-05、F-06、F-07、F-08、F-09、F-11、F-15、F-19、F-29 | **新发现** |
| F-16、F-17 | 新发现（细节级） |
| F-12、F-13、F-14 | 重复（第一轮 J-1、架构性条目） |
| §5 各模块的负面确认 | 与既有审计一致或**证伪**（如 H19 / H33 / H44 / 语音状态机的怀疑被证伪） |

本次审计相对既有审计的**增量价值**：① 首次穷举验证了语音三表与批注草稿的全路径数据边界；② 首次做了云同步实体级字段对照；③ 首次做了 12 提交 × 6 类静默回归的系统对账；④ 首次产出完整的接口真实性分类（含 `FAKE: 0` 的明确结论）；⑤ 首次产出 Android Plugin / Desktop IPC 的完整对照表；⑥ 首次量化了测试对并发负载的敏感性（F-29）。

---

*审计执行：六路并行只读深审 + 主审复核 6 条最高严重度结论 + 关键测试复测。全程未修改任何源码、配置或数据库，未提交 commit / PR，未调用任何真实付费 Provider。*
