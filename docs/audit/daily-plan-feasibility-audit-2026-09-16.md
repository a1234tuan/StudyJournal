# 「学习计划功能设计方案 v2.0」可行性审计

- 审计日期：2026-09-16
- 审计对象：`docs/daily-plan-feature-design-v2.md`（v2.0，标注状态「待审查」）
- 审计性质：**只读审计**。未修改该方案、未修改任何源码、schema、同步协议、备份格式或 UI。
- 审计方法：把方案中的每一条事实性断言逐条回到当前源码 / 当前冻结文档核对；对方案未提及但必然被改动的链路做反向枚举（Dexie store → 快照导出/恢复 → 云同步实体映射 → 备份通道 → 导航状态机 → 数据加载 → 测试枚举）。
- 代码基线：Dexie `schema 23`（`src/db/reviewCoachSchema.ts:130`）、云同步协议 v2、冻结基线 `docs/studyjournal-final-freeze-2026-09-15.md`、产品边界 `docs/新的方案.md`。

---

## 0. 结论摘要

**判定：作为「在当前 StudyJournal 仓库内实施的功能方案」，v2.0 不成立；作为「换个仓库/换阶段实施的需求描述稿」，其核心需求（今日计划 → 日志 → 复习 → AI 反馈）是可实现的，但设计文档目前有 3 处阻断、14 处与代码事实不符或严重不全、2 处内部自相矛盾，不能直接进入开发。**

| 维度 | 结论 |
| --- | --- |
| 需求本身 | 清晰、可测、产品上说得通（「今日有效 / 未填即消失」是一条明确的产品抉择） |
| 治理前提 | ❌ 不满足：仓库自 2026-09-15 起功能冻结，新功能演进被明确排除，且 Exocortex 已规划同类能力 |
| 产品边界 | ❌ 冲突：「完成后自动加入复习（默认开启）」与 `docs/新的方案.md` §4.3 的强制规则对立 |
| 数据模型 | ⚠️ 方向可行，但字段/索引/删除语义与现有 Trash + 墓碑体系未对齐 |
| 云同步 | ⚠️ 可行且改动点被低估一半以上；方案指错了入口函数 |
| 统计口径 | ❌ 自相矛盾：物理删除未完成计划后，「计划完成率」的分母不存在 |
| 界面流转 | ⚠️ 可行，但导航状态机（深度/返回/浏览器历史/安卓返回键）完全未覆盖 |
| 工作量估算 | ❌ 不成立：10–13 天只够覆盖方案写出来的部分，跨边界部分（同步/备份/恢复/测试枚举）未计入 |

**一句话**：方案把「一个页面 + 一张表」当成成本主体，但在这个仓库里，真正的成本主体是「一张新表要同时穿过 6 条链路和 5 个记录消费方」，且有三条路被冻结规则封住。

---

## 1. 阻断级问题

### B-1【阻断】仓库已功能冻结，本方案不属于本仓库的合法范围

- `docs/studyjournal-final-freeze-2026-09-15.md:5`：「StudyJournal 自 2026-09-15 起进入**功能冻结与维护阶段**……不再承接 Exocortex 的产品改名或新功能演进。」
- 同文件 `:83`：「Exocortex 必须从本冻结基线在**新的本地目录和新的远端仓库**中开始。」
- `AGENTS.md` 首条基线同样写明「Future product development and all Exocortex renaming belong in a separate directory and repository」。
- 而 `docs/exocortex-ai-cockpit-migration-and-enhancement-plan-2026-09-15.md:34`（2026-09-15，即冻结当天）已经把「`Goal / Constraint / Capacity`：目标、时间、资源、截止日和**计划恢复**」列为 Exocortex 第一优先层。

因此本方案与冻结声明、`AGENTS.md`、Exocortex 迁移方案三者同时冲突，且与 Exocortex 已规划的「目标/计划」层存在范围重叠。方案自身对这一前提**完全未提及**（方案中没有任何一处引用冻结文档或产品边界文档）。

> 这不是技术问题，但它决定了后面所有技术讨论有没有意义：如果继续在 StudyJournal 落地，必须先由用户显式解冻或把方案移入 Exocortex。

### B-2【阻断】自动加入复习的默认值违反产品边界

- 方案 §7 问题 1 推荐「选项 B：给用户控制权，**默认开启**」，并在 §3.3 生命周期中把 `autoAddToReview=true` 直接接到 `addRecordToReview()`。
- `docs/新的方案.md:107` 是硬规则：「新建日志首次保存且含决策块时，系统自动把整条日志加入间隔复习。**编辑已有日志时，如果该日志原本不在复习队列，系统明确询问一次是否加入，不能静默改变用户原有复习计划。**」
- 代码语义也印证这条规则：`src/services/storageAdapter.ts:1183-1195` 的 `addRecordToReview` 对 `status !== "active"` 的既有复习状态会走 **reset 分支**（`"added"` / `"reset"` 事件）。也就是说，对一个曾被用户移出复习队列的记录调用它，会**把用户主动移除的记录重新拉回队列并写一条 reset 事件**。方案里的「填充即完成 → 调用 addRecordToReview()」正是这条被禁止的静默路径。

建议：`autoAddToReview` 若要保留，只能实现为「首次保存时询问一次」或「复用现有首次保存询问入口」，不能是默认开启的静默调用。

### B-3【阻断】Phase 3（独立 AI 驾驶舱）与冻结的路由语义、使用指南及测试互斥

- 方案 §5.5 建议 Phase 3 把「学习助教」从复习页搬进新的 `AiCockpitPage`。
- `AGENTS.md` 明确保留：「routes Review Coach through `Review -> Learning Coach`」是产品 UI 迁移的冻结语义之一。
- 实现事实：`src/pages/ReviewPage.tsx:845,940` 通过 `coachOpen` 承载「学习助教」；`src/pages/UsageGuidePage.tsx:145` 写死「位于"复习 → 学习助教"的反馈与训练工作区」，并且 `src/pages/UsageGuidePage.test.tsx:44` 用断言把这句话锁住。
- `AGENTS.md` 同时规定使用指南「describes only implemented product capabilities」。

即：Phase 3 至少要同时改动冻结路由语义 + 使用指南正文 + 使用指南测试，属于「改变已冻结的产品路由」，需要产品层重新确认，不能在实现层顺手做。

---

## 2. 与代码事实不符的断言（逐条）

| # | 方案原文 | 实际事实 | 影响 |
| --- | --- | --- | --- |
| F-1 | §2.2 称查看 `createCloudSyncSnapshot()` 得到参与同步的表清单 | `src/services/storageAdapter.ts:2139-2141`：`createCloudSyncSnapshot()` 只有一行 `return this.createSnapshot();`。真正的清单在 `createSnapshot()`（`:2070-2137`，事务表列表见 `:2073`） | §6.2 给出的「修改 createCloudSyncSnapshot」是改错了函数；照抄会得到一份不会生效的补丁 |
| F-2 | §2.2/§6.2 称 `CloudSyncEntityType` 定义在 `src/services/cloudSyncModel.ts` | 实际在 `src/types.ts:817-843` | 改错文件 |
| F-3 | §6.1 称 `blocks` 现有索引为 `"id, type, date, subject, order, createdAt, updatedAt, deletedAt"`，只新增 `planId, isDraft` | 实际 `blocks` 索引自 schema 1 起就是 `"id, date, type, order, updatedAt"`（`src/db/database.ts:131`、`src/db/reviewCoachSchema.ts:13`）。**没有** `subject` / `createdAt` / `deletedAt` 索引 | 「现有基线」部分不实，据此判断索引成本会失真 |
| F-4 | §2.3/§5 称当前无统一驾驶舱入口、统计无 AI 维度 | 前半句成立（`ReviewPage` 的 `coachOpen` 承载）；后半句成立（`StatsPage` 确无 AI 维度）。但「AI 驾驶舱」是文档内部叫法，产品界面叫「学习助教」，方案通篇混用两套命名 | 沟通与检索成本；`src/preview/ReviewCoachPreviewApp.tsx` 是独立预览壳，不是产品入口 |
| F-5 | §2.1 Desktop 端导航画成 今天/日志/复习/录音/更多 + 分类管理/设置 | `src/App.tsx:212-218`：桌面 `navItems` = 今天 / 日志 / 复习 / **录音（`more` 的 `subRoute: "recordings"`，不是独立 Tab）** / 更多；`src/App.tsx:220-225` 安卓 `bottomNavItems` = 今天 / 日志 / 复习 / 更多（安卓 4 Tab 正确）。**分类管理、设置不在桌面主导航里**（`categories` 是 `TabKey`，但不是桌面 `navItems` 成员） | 结论行（入口放「今天」页右上角）不受影响，但导航图本身不准 |
| F-6 | §3.2 `isDraft` 的用途：「过滤'最近日志'列表时使用」 | 记录消费方至少 6 处，且**只有部分是集中选择器**：`getRecordBlocks`（`src/lib/journalSelectors.ts:6`，被 JournalPage / CategoriesPage / StatsPage / RecordingsPage 使用）+ 三处各自 inline 过滤（`src/services/aiContextService.ts:224`、`src/services/knowledgeExportService.ts:33`、`src/pages/TodayPage.tsx:68`）+ 搜索索引（`src/lib/search.ts` 直接吃 `blocks`） | 只改「最近日志」会让空草稿日志污染分类计数、热力图、搜索、AI 知识范围与知识导出 |
| F-7 | §6.1 用 `this.version(X).stores({ ...现有表, dailyPlans })` 表达 schema 升级 | 本仓库的 schema 约定是**在 `src/db/reviewCoachSchema.ts` 里用 spread 累积完整 store 映射**，再由 `database.ts:341-343` 逐个 `version(n).stores(MAP)` 挂载（当前到 22、23）。同时 `REVIEW_COACH_SCHEMA_VERSION` 已到 **23**，而方案与 `AGENTS.md` 都还写着 21 | 方案基于过期的 schema 认知；且漏了「新增版本会带来旧版本 APK 无法降级」的部署后果（见 F-14） |
| F-8 | §3.2 给 `blocks` 索引加 `isDraft` 布尔字段 | IndexedDB 合法键类型不含 boolean：布尔值属性不会进入索引，`where("isDraft").equals(true)` 也拿不到结果 | 索引无效（无害但无用）；过滤只能走内存，方案没写清 |
| F-9 | §3.3「物理删除 DailyPlan + 空 RecordBlock」/ §6.3 清理代码调用 `storage.deleteBlock` | `deleteBlock`（`storageAdapter.ts:1584-1598`）是**软删除**：写 `deletedAt`，记录进回收站（`listDeletedBlocks` / `restoreBlock` / `TrashPage`）。真正的物理删除只有 `permanentlyDeleteBlock`（`:1619-1644`）与 `purgeExpiredDeletedBlocks`（`:1646-1661`） | 方案自身两处口径不一致：按 §6.3 实现，空日志会以「回收站里的空记录」留在用户面前，直接违背 §1.2「不留痕迹」 |
| F-10 | §6.3 清理逻辑用 `toISOString().split('T')[0]` 取昨天 | 项目有专门的 F-03 守卫（`src/lib/localDateContract.test.ts:35,45-52`）禁止用 UTC 时间戳推日历日；`todayISO()` 用 date-fns 本地日历（`src/lib/date.ts:16`）。全仓 `src` 已无 `split("T")` 用法 | 这段代码会被 F-03 守卫的**意图**否掉（正则只拦 `slice(0,10)` 形式，靠 agent 自觉），在 GMT+8 的 00:00–08:00 会算错「昨天」 |
| F-11 | §6.3 清理只查 `yesterdayISO` | 方案 A 只在 App 启动时执行；若用户两天没开 App，3 天前的 pending 计划**永远不会被清理**，且会随云同步一直在多设备间流转 | 「今日有效」的承诺在真实使用下不成立 |
| F-12 | §3.4 情况 2 的 `isEmpty(html)` 用 `/<[^>]*>/g` 剥标签 | 仓库已有权威纯文本提取（`contentToPlainText` / `recordToPlainText`，`src/lib/recordContent.ts`）。裸正则会把「只有图片 / 只有公式 / 只有嵌入资源」的记录判为空——而这类记录一旦走 `permanentlyDeleteBlock` 会连带触发资源清理（`:1636-1639`） | **数据丢失风险**：一张只有手写照片的日志会被当成「未填」删除 |
| F-13 | §9.2 缓解措施「晚上推送通知'还有 X 个计划'」；§6.3 方案 B「使用 Capacitor 的后台任务 API」 | `package.json` 依赖里**没有** `@capacitor/local-notifications` 或任何后台任务/推送插件；仓库有依赖卫生测试（`src/lib/dependencyHygiene.test.ts`）锁住 package.json / lock / vite 分包的「三处一致」 | 这两条缓解措施目前不可实现，需要新增原生依赖 + Android 权限配置 + 原生构建，属独立议题 |
| F-14 | §9.1 缓解「数据迁移失败 → 完整的回滚机制」 | Dexie 在「库版本高于代码版本」时抛 `VersionError`，全仓无任何 `VersionError` / `deleteDatabase` 处理（已检索 `src/`）。schema 23 → 24 之后，用户回装旧 APK/旧桌面版会**直接打不开数据** | 「完整回滚」在 Android/Electron 上是有限度承诺，方案未识别 |
| F-15 | §2.2「需要在 `createCloudSyncSnapshot()` 添加 `dailyPlans`」+ §6.2 只列 3 个函数 | 一条新同步实体实际必须穿过的位置（已核）：`src/types.ts` 的 `CloudSyncEntityType`(:817)、`BackupPayload`(:781)、`BackupManifest.version` 联合类型(:762)、`StorageSnapshot`(:811)；`cloudSyncModel.ts` 的 `exportCloudSync`(:322)、`materializeCloudSyncSnapshot`(:419)、`manifestFor`(:378)、`isBootstrapOnlyCloudData`(:79)；两个把实体类型**逐项写死**的测试（`cloudSyncModel.test.ts:176`、`cloudSyncProtocol.test.ts:156`）；`storageAdapter.ts` 的 `createSnapshot`(:2073)、`createStreamableSnapshot`(:2146)、`restoreSnapshotData`(:2219)、`restoreStreamableSnapshot` 里**显式列出的清表清单**(:2363-2390)；以及 ZIP / 原生流式 / 文件夹仓库 / 记录互通导出链路 | 方案的 Phase 2（2–3 天）严重低估；特别是 `restoreStreamableSnapshot` 的清表清单若漏加，恢复备份会留下陈旧计划 |
| F-16 | §6.4 只加 `dailyPlanOpen` 到一个 `useState` | 导航是手写状态机：`src/lib/tabNavigation.ts:99`（`TabMemory.today`）、`getTabDepth`(:233-267)、`popTabDepth`(:311-443)、`buildTabPageKey`(:284-309)，外加 `src/lib/webNavigationHistory.ts` 的历史恢复校验、`App.tsx:1781` 的 `PageTransition motion`、安卓返回键回退（`App.tsx:753-800`）。`MutableRecordReferenceNavigationEntry` 的深度栈只支持 `record` / `review-queue` 两种条目（:76-88），要做「今天 → 计划 → 编辑器 → 回到计划」需要新增条目类型并同步改环检测与深度上限逻辑 | 这是本方案里最容易低估的一块：`App` 用 `useState` 另起一套状态会破坏返回键、浏览器前进/后退与页面过渡动画（`tabNavigation.test.ts` / `webNavigationHistory.test.ts` 会覆盖到） |

---

## 3. 方案内部的逻辑矛盾

### C-1【高】「物理删除未完成计划」与「统计计划完成率 / 查看 7 天计划历史」互斥

- §3.3 与 §3.4 规定：次日 00:00 **物理删除**所有 `status="pending"` 的 DailyPlan 及其空 RecordBlock，「不留痕迹」。
- 但 §5.2 要求统计「今日计划：Y / Z 完成」；§5.4 Phase 1 要求「近 7 天计划完成率」；§7 问题 4 推荐「查看最近 7 天的计划历史」。
- 完成率 = 完成数 / **创建数**。创建数只存在于被删掉的 pending 行里。**删掉分母就无法算完成率**，这条统计口径与生命周期设计不可同时成立。

可行方向（供决策，非本轮实施）：要么保留一条不含内容的轻量「计划行」（例如 `date + status`，或在日期条目上记 `plannedCount`），要么把统计口径改成「只统计已完成计划」，并同步修改 §5.2/§5.4/§7 的表述。

### C-2【中】「一个计划一个日志」与现有空记录语义不闭环

- §3.2 假设「计划生成的空日志」是唯一需要清理的空记录。实际上今天点「新建记录」直接退出也会留下空记录（`App.tsx:277,1363,1044`：`newlyCreatedRecordIdsRef` 只用于给编辑器传 `isNewRecord`，**没有任何放弃即删除的逻辑**）。
- 方案只在计划链路上做清理，会形成两套空记录语义：计划产生的空记录会消失，手建的空记录留着。用户无法区分，也违背 §1.2 的表述。

### C-3【低】状态机图与实现选中状态不一致

§3.3 的 mermaid 里 `pending --> 用户编辑 --> completed`，但 §1.1 又说「支持当天多次编辑」且 §3.4 情况 2 要求「编辑后又清空 → 退回 pending」。图里没有 `completed --> pending` 的回退边，「有内容 = 完成」这条唯一判据在图上表达不出来。

---

## 4. 被低估的工程面（本方案未提及但必然要做）

1. **数据加载与刷新**：`src/hooks/useAppData.ts:91-92` 是数据装载入口。新增 `dailyPlans` 要接入装载、`refresh()`、以及 `markAutoBackupDirty` 系列写入标记，否则统计页拿不到数据、自动备份也不会因计划变更而触发。
2. **备份通道 4 条都要表态**：手动 ZIP、原生流式 ZIP、文件夹仓库备份（保留 5 份）、云端恢复快照（保留 3 份）。方案只提了云同步一条。
3. **`manifestFor` 的 `counts` 与 `BackupManifest.version: 1|2|3|4|5|6`**：新增 payload 段需要决定是否升版本号并改联合类型，否则类型层直接编译不过。
4. **恢复路径的完整性与「旧备份反噬」**：`assertSnapshotIntegrity`（`storageAdapter.ts:155`）与 `prepareExportContent`（`:264`）是导出/恢复的统一守卫。另外已有审计记录的第 1 号极高风险（恢复旧备份后云同步会用墓碑删除云端较新数据，见 `docs/audit/cloud-sync-backup-boundary-audit-2026-09-13.md` §14-D.1）会因为「计划频繁创建/物理删除」而被更频繁地触发。
5. **物理删除在云同步里能否传播**：能。`src/services/cloudSyncService.ts:629-642` 的 `deriveLocalCloudChanges` 会把「账本里有、本地没有」的 key 自动变成墓碑（`tombstoneFor:599`）。所以 §3.3 的物理删除**不会**导致跨设备复活——但这条成立的原因是账本墓碑机制，不是方案里写的机制；方案没有意识到自己依赖了它。
6. **实体携带 `deletedAt` 的语义**：`BaseEntity.deletedAt` 存在意味着「删除 = 墓碑」。DailyPlan 若同时有「物理删除」和「云同步」，必须明确写出「物理删除依赖账本反向墓碑」，否则实现者很可能改回软删除（进回收站），再次撞上 F-9。
7. **测试面**：`cloudSyncModel.test.ts` / `cloudSyncProtocol.test.ts` 把实体类型逐项写死；`tabNavigation.test.ts` / `webNavigationHistory.test.ts` 覆盖深度与历史；`e2e/ui-v2-*.spec.ts` / `stats-page.spec.ts` 覆盖相关页面。方案没有测试计划，只有「单元测试 / 边界情况测试」两行。
8. **验证口径**：冻结基线要求跨边界改动跑完整验证（`npm run test` + `test:e2e` + `test:firebase` + `build`，见冻结文档 §8）。新增同步实体属于「备份/恢复/同步」边界，不能只跑局部测试。
9. **`NON_CONFLICTING_ENTITY_TYPES` 与合并粒度**：`cloudSyncModel.ts:106` 与 `mergeCloudSyncSmallEntity`(:558-626) 只对 `settings` / `template` 做字段级三方合并。DailyPlan 默认走实体级二选一——「两台设备同时勾选不同计划」会触发冲突弹窗，方案完全没提多设备交互。

---

## 5. 方案中已被证实的正确部分（不必推翻）

| 断言 | 核实结果 |
| --- | --- |
| §2.1「今日计划入口放在'今天'界面右上角，与'今天想记下什么？'同一行右侧」 | ✅ 已存在：`src/pages/TodayPage.tsx:77-86` 的 `PageHeader.titleActions` 就是一个 `今日计划` 按钮。**但它目前是一个死按钮**——全仓检索 `onOpenDailyPlan` 只有 `TodayPage.tsx:25,49,83` 三处，`App.tsx` 从未传入，点击等于空操作（默认 `() => undefined`）。好消息：入口位已经预留，不需要动 TodayPage 的头部结构 |
| §2.2 参与云同步的表清单 | ✅ 内容基本正确（`createSnapshot` `:2070-2137` + `exportCloudSync` `cloudSyncModel.ts:322-368`），`assets` 排除 `generatedBy === "knowledge-podcast"` 也对（`:353`）。只是函数归属写错了（F-1）；且漏了 `recordDrafts`（以 `draft` 实体参与同步，`:328`），而它正好和「空草稿」相关 |
| §5.1 StatsPage 现有内容 | ✅ 与 `src/pages/StatsPage.tsx:57-100` 高度一致（今日待复习 / 今日完成进度 / 逾期积压 / 近 7、30 天回忆成功率 / 连续复习 / 热力图与趋势） |
| §2.3「学习助教在复习页，通过 `coachOpen` 切换」 | ✅ `src/pages/ReviewPage.tsx:845,940` |
| §4.3 复用 `PageTransition` 的 `motion` prop | ✅ `src/App.tsx:1781` 正是 `<PageTransition pageKey={pageKey} motion={navigationMotion}>`，`motion` 支持 `forward` / `back` / `tab` / `none` |
| §6.2「需要给 `CloudSyncEntityType` 加 `daily-plan`」 | ✅ 方向正确（位置写错，见 F-2）。另外 `firestore.rules:4-6` 是按 `users/{userId}/{document=**}` 放开的，**新增实体类型不需要改规则**（这条方案没提，但对方案有利） |
| §3.3「完成后调用 `addRecordToReview()`」 | ✅ 该 API 存在（`storageAdapter.ts:1183`），只是默认调用会撞上 B-2 |
| §5.4 分阶段（先扩 StatsPage、后期再独立驾驶舱） | ✅ 与仓库的渐进式惯例一致；Phase 1 的统计一旦按 C-1 修正口径，是成本最低、风险最小的一段 |

---

## 6. 若要继续推进，建议的最小前置条件

按依赖顺序（每一条都是「做之前必须先有结论」，不是实现动作）：

1. **定范围**：确认是在 StudyJournal 解冻落地，还是并入 Exocortex。未定之前不应动任何代码。
2. **修产品规则冲突**：把「完成后是否加入复习」的交互写进 `docs/新的方案.md` 并重新确认，取消默认静默加入（B-2）。
3. **修统计口径矛盾**：在「物理删除 pending」与「计划完成率」之间二选一，并同步改 §5/§7（C-1）。
4. **补齐同步/备份/恢复的完整改动清单**：把 F-15 里的位置写成显式 checklist，特别是 `restoreStreamableSnapshot` 的清表清单与 `BackupManifest.version`。
5. **定义 `isDraft` 的全部消费语义**：列出 6 个记录消费方各自的处理方式，或者放弃 `isDraft`、改成「计划未填写前不创建记录」这一更小的状态空间。
6. **定义空判据**：用 `recordContent` 的现成纯文本/资源提取，明确「只有图片/公式算不算有内容」，并写死「被判定为空的记录是否允许物理删除资源」。
7. **导航方案**：选择「扩展 `TabMemory.today` 的深度状态机（含返回键与浏览器历史）」或「计划页作为更多子路由」。不要用独立 `useState`。
8. **重置工作量口径**：方案给出的 10–13 天只覆盖了 UI + 数据层；跨边界部分（同步 + 备份 + 恢复 + 测试枚举 + 全量验证）需要单独估。

---

## 7. 风险与不确定性（审计自身的边界）

- 本次审计是**静态核查**，未运行测试、未做真机验证；所有结论基于源码与文档的当前状态。
- §5 中标注 ✅ 的项是核对过的；`§2.1 Desktop 导航图` 的不准确只影响文档表述，不影响方案的落地结论。
- 冻结状态本身是**人类决策**而非技术事实：如果用户明确要解冻，B-1 自动消失，但 B-2、B-3、C-1 与全部 F 项仍然成立。

---

## 附录：核查证据索引

| 主题 | 位置 |
| --- | --- |
| 冻结声明与 Exocortex 分离规则 | `docs/studyjournal-final-freeze-2026-09-15.md:5,83` |
| 自动加入复习的强制规则 | `docs/新的方案.md:107` |
| 已冻结产品边界 | `docs/新的方案.md:738-750` |
| Exocortex 计划/目标层 | `docs/exocortex-ai-cockpit-migration-and-enhancement-plan-2026-09-15.md:34` |
| 现有云同步/备份边界审计（极高风险 #1） | `docs/audit/cloud-sync-backup-boundary-audit-2026-09-13.md:294,515-518` |
| Dexie 版本与 block 索引 | `src/db/database.ts:131,341-343`；`src/db/reviewCoachSchema.ts:13,119-130` |
| 快照导出/恢复 | `src/services/storageAdapter.ts:2070,2139,2146,2219,2363` |
| 云同步实体映射 | `src/services/cloudSyncModel.ts:79,106,322,378,419`；`src/types.ts:762,781,811,817` |
| 墓碑与本地增量 | `src/services/cloudSyncService.ts:599,629-642` |
| 软删除/回收站/物理删除 | `src/services/storageAdapter.ts:1584,1600,1607,1619,1646` |
| 复习加入语义 | `src/services/storageAdapter.ts:1183-1195` |
| 本地日期守卫 | `src/lib/localDateContract.test.ts:35,45-52`；`src/lib/date.ts:16` |
| 导航状态机 | `src/lib/tabNavigation.ts:76-88,99,233,284,311`；`src/App.tsx:212-225,753-800,1781` |
| 记录消费方过滤点 | `src/lib/journalSelectors.ts:6`；`src/services/aiContextService.ts:224`；`src/services/knowledgeExportService.ts:33`；`src/pages/TodayPage.tsx:68`；`src/lib/search.ts` |
| 死按钮证据 | `src/pages/TodayPage.tsx:25,49,83`（无调用方） |
| 依赖能力缺口 | `package.json`（无 local-notifications / background-runner）；`src/lib/dependencyHygiene.test.ts` |
| 使用指南锁定 | `src/pages/UsageGuidePage.tsx:145`；`src/pages/UsageGuidePage.test.tsx:44` |
