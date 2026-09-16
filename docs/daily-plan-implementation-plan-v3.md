# 「今日计划」实施方案 v3（2026-09-16）

> ⚠️ **本文已被取代（2026-09-16）。** 定稿方案见 `docs/daily-plan-final-plan-2026-09-16.md`（含逐文件执行清单 T1-T22、两轮审计复核的 18 条修订、P1-P6 门禁）。本文保留作历史记录，**不要再据本文实现**。

- 需求基线：`docs/daily-plan-intent-2026-09-16.md`（已确认 3 项决策）
- 解冻依据：`docs/studyjournal-scope-unfreeze-2026-09-16.md`
- 被取代：`docs/daily-plan-feature-design-v2.md`（其 §3 / §5.5 / §6 / §7 多处结论已被需求基线与本方案取代）
- 性质：可执行实施方案。**本文件不包含代码改动**，实施按 §8 分期进行。

---

## 0. 与 v2 的差别：本方案更小

| | v2 方案 | 本方案 | 原因 |
| --- | --- | --- | --- |
| 新增表 | `dailyPlans` + `blocks` 两个新索引 | **只有 `dailyPlans` 一张表** | 完成度用内存推导，不需要 `isDraft` / `planId` 索引 |
| 既有表索引 | 改 `blocks` 索引（含 `subject/createdAt/deletedAt` 不实项） | **一处不改** | 避免大表索引重建；`blocks` 已在内存全量加载 |
| 状态字段 | `status: pending \| completed` | **不存状态**，由「记录是否存在」推导 | 消除状态与事实不一致的可能 |
| 定时任务 | 次日 00:00 清理空计划 | **没有定时任务** | 「不预生成」+ 空记录回收，跨天问题自然消失 |
| 复习开关 | 新增 `autoAddToReview`（默认开启） | **不加**，继承既有规则 | `docs/新的方案.md:107` 禁止静默改变复习队列 |
| 驾驶舱 | 新增 `AiCockpitPage` 并搬迁学习助教 | **不动**，只做页内统计 | 冻结路由 `复习 → 学习助教` |
| UI 新增 | 2 个页面 + 1 个新子路由 | 1 个页面（页内两个视图） | 避免导航深度栈膨胀 |

---

## 1. 数据模型（最终形态）

### 1.1 新增 `DailyPlan`（`src/types.ts`）

```ts
export interface DailyPlan extends BaseEntity {
  date: ISODate;                 // 计划日期（本地日历日）
  subject: Subject;              // 学科（复用 SubjectConfig 的学科名）
  title: string;                 // 计划标题，即用户输入的计划内容（**UI 限 40 字**；数据层不校验。
                                 //   超长内容约定拆成同一学科下的多条计划，故不存在「一学科一天一计划」的唯一约束）
  order: number;                 // 同日内排序
  linkedRecordId?: EntityId;     // 已产生的日志记录；未填写时为空
}
```

**刻意不加的字段**：`status`（由记录推导）、`abandoned`、`autoAddToReview`、`reviewKind`、`completedAt`。

### 1.2 `RecordBlock` 增加一个可选字段

```ts
planId?: EntityId;               // 归属声明：这条日志来自某个计划
```

- 为什么两边都存：`DailyPlan.linkedRecordId` 是「计划 → 记录」的快速通道（列表直接读，无需索引）；`RecordBlock.planId` 是记录自身的**归属声明**，满足需求第 5 条「特别声明属于计划」，并且在计划行被删除后仍然成立。
- 真源约定：**完成判定读 `linkedRecordId`**；`planId` 只用于展示与归属查询（反查可由内存里的 `dailyPlans` 建 Map）。
- 哈希影响：`planId` 为 `undefined` 时不进入稳定 JSON，既有记录的内容哈希不变；计划产生的记录会因此改变一次哈希并随同步上行，属正常增量。

### 1.3 schema 24

```ts
// src/db/reviewCoachSchema.ts
export const DAILY_PLAN_SCHEMA_24_STORES = {
  ...REVIEW_COACH_SCHEMA_23_STORES,
  dailyPlans: "id, date, updatedAt, createdAt, linkedRecordId",
} as const;
export const REVIEW_COACH_SCHEMA_VERSION = 24;
```

- 索引只用字符串/数值字段，**不用布尔**（IndexedDB 不接受布尔键）。
- 不加 `deletedAt` 索引：计划删除走软删除（与其它实体一致），计划数量极小，内存过滤足够。

---

## 2. 生命周期（没有定时任务的版本）

```
用户列计划              → 只写 DailyPlan 一行（无记录、无状态）
用户点计划条目          → 复用现有「先建后编」惯例：创建记录（title = 计划标题，planId = 计划 id），
                          回填 linkedRecordId，进入编辑器
                          （计划标题写入的是 `RecordBlock.title`，正文留空；日志标题在编辑器里仍可自由修改，
                            之后若与计划标题不一致，计划行以计划标题为主、日志标题作为附注——详见详细设计 §8.3）
用户写内容并保存        → 记录成为正式日志；计划显示「已完成」+ 绿色对号
用户点进去但没写就退出  → 该空记录被回收（同时清空 linkedRecordId）→ 计划回到「未完成」
用户写了但没按保存      → 本机草稿存在 → 记录不回收；重新打开可继续写
用户删掉日志            → 记录软删除（进回收站）→ 计划显示「未完成」，无需级联逻辑
用户删掉计划            → 计划行软删除；日志保留为普通日志（归属声明保留在记录上）
```

### 2.1 「空记录」的判据（唯一需要认真定义的地方）

```
isEmpty = 正文纯文本为空
        ∧ assets 为空 ∧ formulas 为空 ∧ tags 为空
        ∧ 无决策块 ∧ 未加入复习
        ∧ 该记录没有本机草稿（recordDrafts 里没有这一行）
```

- 纯文本必须走 `src/lib/recordContent.ts` 的既有提取（`recordToPlainText` / contentToPlainText），**不用裸正则**：裸正则会误判「只有图片 / 只有公式」的日志为空，进而触发资源清理（审计 F-12）。
- **标题不参与判空**：计划产生的记录天然带标题。
- 含「无本机草稿」这一条是为了避开竞态：编辑器返回时 `flushDraft()` 会先落盘草稿（`src/pages/RecordEditorPage.tsx:642-659`），因此不需要改动它「返回不阻塞存储」的语义。

### 2.2 回收时机（同一个幂等函数，三处调用）

| 时机 | 位置 | 作用 |
| --- | --- | --- |
| 从编辑器返回后 | `App.tsx` 的关闭记录回调之后 | 覆盖「点进去没写就退出」 |
| 打开今日计划页时 | `DailyPlanPage` 挂载 | 覆盖「保存了空内容」 |
| 应用启动时 | 既有启动初始化链路 | 兜底覆盖「编辑器未正常退出」 |

回收动作 = `permanentlyDeleteBlock(recordId)`（复用既有物理删除，含资源清理与投影重建） + 清空 `linkedRecordId`。

---

## 3. 改动清单（逐文件、可直接当 checklist）

> 行号为本文件写作时的代码基线（schema 23）。实施时以当时源码为准。

### A. 类型与 schema

| # | 文件 | 改动 |
| --- | --- | --- |
| A1 | `src/types.ts` | 新增 `DailyPlan`；`RecordBlock` 加 `planId?`；`BackupPayload` 加 `dailyPlans?: DailyPlan[]`；`CloudSyncEntityType` 加 `"daily-plan"`；`BackupManifest.counts` 加可选 `dailyPlans?: number` |
| A2 | `src/db/reviewCoachSchema.ts` | 新增 `DAILY_PLAN_SCHEMA_24_STORES`（:119-122 之后）；`REVIEW_COACH_SCHEMA_VERSION` → 24（:130） |
| A3 | `src/db/database.ts` | 类声明加 `dailyPlans!: Table<DailyPlan, string>`（:119 之后）；构造器加 `this.version(24).stores(DAILY_PLAN_SCHEMA_24_STORES)`（:343 之后） |

### B. 存储层（`src/services/storageAdapter.ts`）

| # | 位置 | 改动 |
| --- | --- | --- |
| B1 | 新增方法（建议放在 review 相关方法之后） | `listDailyPlans(date?)` / `getDailyPlan(id)` / `saveDailyPlan(plan)` / `deleteDailyPlan(id)` / `linkPlanRecord(planId, recordId)`；**每个写操作都必须 `markCloudSyncMutation()`**（参照 `deleteBlock:1584`） |
| B2 | `createSnapshot`（:2070-2137） | 事务表列表（:2073）、`Promise.all`（:2075）、返回对象（:2090）、payload（:2109 附近）四处同步加 `dailyPlans` |
| B3 | `createStreamableSnapshot`（:2143-2210） | 同上（:2146 / :2148 / :2163 / :2190 附近） |
| B4 | `restoreSnapshotData`（:2219 起） | 清表与 `bulkPut` 加 `db.dailyPlans`；读取 `snapshot.payload.dailyPlans ?? []` |
| B5 | `restoreStreamableSnapshot`（:2363 的显式清表清单） | **必须加 `db.dailyPlans.clear()`**，否则恢复后残留旧计划 |
| B6 | `clearAll`（:2396） | 加 `db.dailyPlans` |
| B7 | 空记录回收 | 新增 `reclaimEmptyPlanRecord(recordId)`：判空（§2.1）→ `permanentlyDeleteBlock` → `linkPlanRecord(planId, undefined)` |

### C. 云同步

| # | 文件 | 改动 |
| --- | --- | --- |
| C1 | `src/services/cloudSyncModel.ts` `exportCloudSync`（:322-368） | `ordinary` 加 `mapEntities("daily-plan", snapshot.payload.dailyPlans ?? [])` |
| C2 | 同上 `materializeCloudSyncSnapshot`（:419-472） | payload 加 `dailyPlans: values<DailyPlan>(entities, "daily-plan")` |
| C3 | 同上 `manifestFor`（:378-417） | counts 加 `dailyPlans: count("daily-plan")` |
| C4 | 同上 `isBootstrapOnlyCloudData`（:79-99） | **无需改动**（:91 已把任何非 `settings`/`tag` 实体判为非 bootstrap，新类型自动正确） |
| C5 | `src/services/cloudSyncModel.test.ts:176`、`src/services/cloudSyncProtocol.test.ts:156` | 实体类型逐项清单加 `"daily-plan"` |

不需要改：`firestore.rules`（按用户放开）、`PROTOCOL_VERSION`、冲突与和并策略（计划走实体级二选一，与 `block` 同级）。

### D. 备份与恢复（4 条通道 + 2 个载荷枚举）

| # | 文件:位置 | 改动 |
| --- | --- | --- |
| D1 | `src/services/backup.ts:49` 附近（`snapshotToZip`） | 写入 `dailyPlans` |
| D2 | `src/services/backup.ts:200` 附近（`zipToSnapshot`） | `dailyPlans: data.dailyPlans ?? []` |
| D3 | `src/services/backup.ts:101`（`summarizeSnapshot`） | 可选：把计划数并入导入摘要 |
| D4 | `src/services/nativeAutoBackupStreamService.ts:58` 附近 | 同上 |
| D5 | `src/services/exportPrivacy.ts`（`sanitizeStreamableSnapshotForExport:50`） | 计划不含敏感字段，**确认无需剥离**（写一条注释说明） |
| D6 | `src/services/storageAdapter.ts:155`（`assertSnapshotIntegrity`） | 计划不引用资源，**无需改**；实施时确认不误伤 |

### E. 数据装载

| # | 文件:位置 | 改动 |
| --- | --- | --- |
| E1 | `src/hooks/useAppData.ts` 的 `refresh()`（:88-118） | 加 `storage.listDailyPlans()` + `dailyPlans` state |
| E2 | 同上 `createRecordBlock`（:816-838） | 增加可选参数以支持标题与归属：`options?: { title?: string; planId?: EntityId }`（当前标题由 `nextRecordTitle` 自动生成） |
| E3 | 同上导出面 | 新增 `createDailyPlan` / `deleteDailyPlan` / `createRecordFromPlan`（组合 E2 + B1 的 `linkPlanRecord`）/ `reclaimEmptyPlanRecord` |

### F. 导航与返回

| # | 文件:位置 | 改动 |
| --- | --- | --- |
| F1 | `src/lib/tabNavigation.ts:99` | `TabMemory.today` 加 `planOpen?: boolean`、`planView?: "today" \| "history"` |
| F2 | 同上 `getTabDepth`（:233-267） | today 分支改为：`recordId ? (planOpen ? 2 : 1) + refDepth : planOpen ? 1 : adaptiveTaskId ? 1 : 0` |
| F3 | 同上 `popTabDepth`（:311-326） | today 顺序：先清 `recordId`（保留 `planOpen`，即回到计划页）→ 再清 `planOpen` → 再 `adaptiveTaskId` |
| F4 | 同上 `buildTabPageKey`（:284-309） | today 的 pageKey 加入 `planOpen` 与 `planView` 令牌，保证过渡动画与历史恢复稳定 |
| F5 | `src/lib/webNavigationHistory.ts:248` | today 恢复加 `planOpen: optionalBoolean(...)`、`planView` 白名单校验（`["today","history"]`） |
| F6 | `src/App.tsx` | 新增 `openDailyPlan` / `closeDailyPlan` / `openPlanRecord`；today 分支渲染 `planOpen ? <DailyPlanPage/> : <TodayPage/>`（`currentRecord` 优先，既有逻辑不变） |
| F7 | `src/App.tsx:1369` 附近 | 给 `TodayPage` 传 `onOpenDailyPlan={openDailyPlan}`（**按钮已存在，只是从未接线**） |
| F8 | 安卓返回键（`App.tsx:753-800`） | **无需改动**：逻辑只看深度，F2/F3 改好后自动正确 |

### G. UI

| # | 文件 | 改动 |
| --- | --- | --- |
| G1 | 新增 `src/pages/DailyPlanPage.tsx` | 页内两个视图（`planView`）：**今日**（列表 + 新建表单 + 顶部摘要）与**历史**（按日期分组 + 周/月汇总）。历史做成页内视图而非新导航层，避免深度栈膨胀 |
| G2 | `src/pages/RecordEditorPage.tsx` | 记录 `planId` 有值时显示只读标识「来自计划 · <计划标题>」。**不改任何保存/评分语义** |
| G3 | `src/styles/visual-v2.css` | 新增 `.daily-plan-page` 作用域样式，同时适配 `reading` / `modern` 两个视觉主题与窄屏 |
| G4 | `src/pages/UsageGuidePage.tsx` | 可选：在既有章节里补一段「今日计划」。注意该页有断言测试，且只描述已实现能力 |

### H. 统计（L0，纯函数）

| # | 文件 | 改动 |
| --- | --- | --- |
| H1 | 新增 `src/lib/planStats.ts` | `今天的 Y/Z`、近 7/30 天完成率、连续「有计划且全部完成」天数、按学科的计划数/完成数、按日期分组的历史；全部为纯函数，对齐 `src/lib/learningStats.ts` 的风格 |
| H2 | 新增 `src/lib/planStats.test.ts` | 边界：无计划、全完成、全未完成、跨月、单日多学科 |

### I. 测试与验收

| # | 项 | 内容 |
| --- | --- | --- |
| I1 | 新增 | `storageAdapter.dailyPlan.test.ts`（CRUD + 回收判空 + 清理 `linkedRecordId`） |
| I2 | 新增 | `DailyPlanPage.test.tsx`（新建、完成态对号、历史分组、空状态） |
| I3 | 更新 | `TodayPage.test.tsx`（入口按钮从死按钮变为可用） |
| I4 | 更新 | `tabNavigation.test.ts` / `webNavigationHistory.test.ts`（today 新深度与恢复） |
| I5 | 更新 | `cloudSyncModel.test.ts` / `cloudSyncProtocol.test.ts`（实体类型清单） |
| I6 | 更新 | `database.migration.test.ts`（23 → 24 迁移） |
| I7 | 新增 | `e2e/daily-plan.spec.ts`（列计划 → 写日志 → 完成对号 → 返回层级正确；未写就退出 → 回到未完成） |
| I8 | 全量 | `npm run test -- --exclude "**/*.live.test.ts"`；`npm run test:e2e`；`npm run test:firebase`；`npm run build`；`git diff --check` |

---

## 4. 明确的「不做」清单

1. 不做「周计划 / 月计划」这类新的计划实体——只做按周/月的**汇总统计视图**。
2. 不做计划优先级、截止日、任务状态机、子任务、重复计划。
3. 不做模型调用（不把计划喂给 LLM，不生成 AI 文案）。计划只进 L0 确定性统计。
4. 不动 `settings`、不动 `reviewAnnotationDrafts` / 语音三表 / `aiSecrets` 的边界。
5. 不新增 Capacitor 插件（含本地通知、后台任务）。
6. 不改 `blocks` 索引、不改 `PROTOCOL_VERSION`、不改冲突解决策略。
7. 不搬「学习助教」入口、不改 `UsageGuidePage` 的既有断言。
8. 不改既有日志、复习、评分、导出语义；「来自计划」只是归属声明。

---

## 5. 分期

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| P1 | A + B1（数据层与 CRUD） | `database.migration.test.ts` 通过；CRUD 单测通过 |
| P2 | B7 + E（装载与空记录回收） | 回收单测通过；`refresh()` 能拿到计划 |
| P3 | F + G1/G2（导航与界面） | 手工在 Android 窄屏与桌面各走一遍 §2 全部分支 |
| P4 | H（统计） | `planStats.test.ts` 通过；今日/历史两个视图数字正确 |
| P5 | C + D（同步与备份穿透） | 两设备同步、ZIP 往返、文件夹备份各验证一次 |
| P6 | I（测试补全与全量验收） | §3-I8 全部命令通过 |

**P1-P4 是可独立交付的最小闭环；P5 之前严禁宣称「数据不会丢」**——计划数据在 P5 完成前不参与备份与同步。

---

## 6. 风险与对策

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| schema 24 单向，旧版本回装打不开数据（仓库无 `VersionError` 处理） | 高 | 发布说明写明不支持回装；不把该限制当作已知问题沉默处理 |
| 空记录回收误删有内容的记录 | 高 | 判据走 `recordContent` 既有提取 + 资源/公式/标签/决策块/复习/草稿六项；回收前不做任何资源清理以外的动作；补 I1 的边界测试（图片-only、公式-only） |
| 服务器/多设备：两台设备各自建计划 | 中 | 计划走实体级二选一（与 `block` 同级），不新增合并策略；不做跨设备「同一计划」的自动合并 |
| 恢复旧 ZIP 后云同步反向墓碑（既有极高风险） | 中 | 计划不新增该路径；但计划频繁创建会提高触发概率，实施时在 P5 复测 `docs/audit/cloud-sync-backup-boundary-audit-2026-09-13.md` §14-D.1 场景 |
| 导航深度改动破坏返回键/浏览器历史 | 中 | F2/F3/F4/F5 必须与 I4 同批提交，不允许分开验证 |
| `createRecordBlock` 签名扩展影响既有调用点 | 低 | 新参数为可选对象，既有 4 个调用点无需改动 |

---

## 7. 为 Exocortex 迁移准备

- 计划能力的契约面只有三处：`DailyPlan`、`RecordBlock.planId`、`"daily-plan"` 实体类型。三者都进 `BackupPayload` 与云同步清单，新仓库可用同一条导入器读取。
- 不新增设置项，不改 `settings` 同步契约。
- `src/lib/planStats.ts` 与 `DailyPlanPage.tsx` 保持对 StudyJournal 其它模块的单向依赖（只读 `blocks` / `dailyPlans` / `subjects`），便于整体搬运。
- 完整摘除时只留两个无害残留（`dailyPlans` 表、`planId` 字段）。

---

## 附：一处建议的顺带修复（不属于本方案范围）

首页「新建记录」也有同样的空记录问题（`App.tsx:277,1363,1044` 的 `newlyCreatedRecordIdsRef` 只用于传 `isNewRecord`，没有放弃即回收的逻辑）。若 P2 的空判据函数做成通用工具，建议后续一并用于首页新建流程——这样不会出现「计划产生的空记录会消失、手建的空记录会留着」两套语义（对应审计 C-2）。**本方案不包含这项改动**，仅记录。
