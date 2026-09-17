# 「今日计划」详细设计（2026-09-16）

> ⚠️ **本文已被取代（2026-09-16）。** 定稿方案见 `docs/daily-plan-final-plan-2026-09-16.md`，其中并入两轮审计复核的全部 18 条修订（含 §5.3 回收器竞态、§7.3 恢复语义、§6.2-6.4 导航三处修正）。本文保留作历史记录，**不要再据本文实现**。

> 文档定位：可直接据以实现与验收的详细设计（LLD）。
> 上游文件：需求 `docs/daily-plan-intent-2026-09-16.md` → 解冻 `docs/studyjournal-scope-unfreeze-2026-09-16.md` → 方案 `docs/daily-plan-implementation-plan-v3.md` → 本文。
> 代码基线：Dexie schema 23。本文中的行号为写作时基线，实施以当时源码为准。
> 本文只做设计，**不含代码改动**。

---

## 1. 范围与术语

### 1.1 范围

在既有「日志」之上增加一层**意图声明**：用户按学科列出当天计划；计划可被兑现为一条**完全等价的普通日志**；计划行长期保留，用于完成度统计与计划历史。

### 1.2 非目标

不做优先级 / 截止日 / 子任务 / 重复计划 / 任务状态机；不做「周计划 / 月计划」实体（只做汇总视图）；不做模型调用；不改任何既有实体语义、同步协议版本与冲突策略；不新增原生插件。

### 1.3 术语

| 术语 | 含义 |
| --- | --- |
| 计划 / 计划行 | `DailyPlan` 一行，只含 日期 + 学科 + 标题 + 排序 + 关联记录 |
| 计划记录 / 计划日志 | 由计划兑现出来的 `RecordBlock`（带 `planId`） |
| 兑现 | 用户点开计划并保存内容，产生计划记录 |
| 空记录 | 判据见 §4.2；不会被长期保留 |
| 完成度 | `已完成计划数 / 当日计划总数`（派生，不落库） |

---

## 2. 数据设计

### 2.1 `DailyPlan` 实体

| 字段 | 类型 | 必填 | 来源 / 规则 |
| --- | --- | --- | --- |
| `id` | `EntityId` | ✓ | `newId()`（12 位 nanoid） |
| `createdAt` / `updatedAt` | `ISODateTime` | ✓ | `createBaseEntity()` / `touch()` |
| `deletedAt` | `ISODateTime?` | – | 软删除；删除计划**不**删除日志 |
| `date` | `ISODate` | ✓ | **本地日历日**，只用 `todayISO()` / `addDaysISO()`；禁止从 UTC 时间戳推日历日（仓库有 F-03 守卫） |
| `subject` | `Subject` | ✓ | 从 `subjects` 选择；允许保留已归档学科的历史值 |
| `title` | `string` | ✓ | 用户输入的计划内容，`trim()` 后非空；**UI 限 40 字**（数据层不硬校验，利于导入）。超长计划请拆成多条计划，同一天同一学科允许多条（见 §9 边界 2） |
| `order` | `number` | ✓ | 同日内排序；新建时 = 当日最大值 + 1 |
| `linkedRecordId` | `EntityId?` | – | 兑现后写入；回收空记录时清空 |

**刻意不存在的字段**：`status`、`completedAt`、`abandoned`、`autoAddToReview`、`reviewKind`。完成度与复习归属全部派生，避免「字段与事实不一致」。

**派生字段（不入库，仅内存）**：`outcome: "done" | "pending" | "draft"`（定义见 §4.1）。

### 2.2 `RecordBlock` 增加一个字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `planId` | `EntityId?` | 归属声明：这条日志来自哪个计划 |

- **两边都存的理由**：`DailyPlan.linkedRecordId`（计划 → 记录）用于列表直接判定，无需索引；`RecordBlock.planId`（记录 → 计划）是记录自身的归属声明，在计划行被删除后仍然成立，且随内容一起流动（导出、记录互通、Exocortex 迁移）。
- **真源约定**：`linkedRecordId` 是判定真源；`planId` 只用于展示与归属查询。反查由内存中的 `dailyPlans` 建 Map，无需索引。
- **哈希影响**：`planId === undefined` 时不进入稳定 JSON（`sortValue` 会跳过 `undefined`），既有记录哈希不变；计划记录首次带 `planId` 上行会改变一次哈希，属正常增量。

### 2.3 schema 24

```ts
// src/db/reviewCoachSchema.ts
export const DAILY_PLAN_SCHEMA_24_STORES = {
  ...REVIEW_COACH_SCHEMA_23_STORES,
  dailyPlans: "id, date, updatedAt, createdAt, linkedRecordId",
} as const;

export const REVIEW_COACH_SCHEMA_VERSION = 24;   // 原为 23
```

```ts
// src/db/database.ts
dailyPlans!: Table<DailyPlan, string>;
// 构造函数末尾：
this.version(24).stores(DAILY_PLAN_SCHEMA_24_STORES);
```

沿用本仓库「完整 store 映射 + spread 累积」的既有约定，不在 `database.ts` 里内联 store 字符串。

### 2.4 索引决策

| 决策 | 理由 |
| --- | --- |
| `date` 建索引 | 今日视图与历史视图都按日期查询，`where("date").equals()` 是主路径 |
| `linkedRecordId` 建索引 | 便于「这个记录属于哪个计划」的定向查询与未来的数据修复脚本 |
| **不建 `deletedAt` 索引** | 计划数量极小（每天个位数），内存过滤成本可忽略；且仓库既有表也未对 `deletedAt` 建索引 |
| **不给 `blocks` 加 `planId` 索引** | `blocks` 已在 `useAppData.refresh()` 全量加载；加索引会触发大表索引重建，收益为零 |
| **不使用布尔字段做索引** | IndexedDB 不接受布尔键，布尔字段进索引等于没有索引 |

### 2.5 数据不变量

| 编号 | 不变量 | 违反时的处理 |
| --- | --- | --- |
| I1 | 一个计划最多关联一条未删除的记录 | 回收器修复：视为未完成并清空 `linkedRecordId` |
| I2 | `linkedRecordId` 只指向 `type === "record"` 且未删除的记录 | 同上 |
| I3 | 计划记录必须带 `planId` 且等于该计划 id | 不自动修复（以记录为准，避免误改用户数据），仅在归属展示上容错 |
| I4 | `date` 是本地日历日 | 由构造路径保证（不使用 UTC 推日期） |
| I5 | 计划不引用资源、不持有复习状态 | 由数据类型保证（无相关字段） |
| I6 | 空记录不长期存在 | 由回收器保证（时机见 §5.3） |
| I7 | 删除计划不删除日志；删除日志不删除计划 | 由实现保证（不做任何级联删除） |

---

## 3. 领域逻辑层（纯函数）

建议落在两个新文件：`src/lib/dailyPlan.ts`（视图派生）与 `src/lib/planStats.ts`（统计），风格对齐既有 `src/lib/learningStats.ts`（纯函数 + 独立测试）。

### 3.1 类型

```ts
export type PlanOutcome = "done" | "pending" | "draft";

export interface DailyPlanView {
  plan: DailyPlan;
  outcome: PlanOutcome;
  record?: RecordBlock;     // outcome === "done" 时的记录
  hasDraft: boolean;
}

export interface PlanDateGroup {
  date: ISODate;
  views: DailyPlanView[];
  doneCount: number;
  totalCount: number;
}
```

### 3.2 完成判定 `resolvePlanOutcome(plan, ctx)`

判定顺序（**先看记录，再看草稿**）：

| `linkedRecordId` | 记录存在且未删除 | 记录非空 | 有本机草稿 | outcome | UI |
| --- | --- | --- | --- | --- | --- |
| 空 | – | – | – | `pending` | 未完成 |
| 有 | 否 | – | 否 | `pending` | 未完成（并标记待修复） |
| 有 | 是 | 是 | – | `done` | 已完成 + 绿色对号 |
| 有 | 是 | 否 | 是 | `draft` | 未保存（可点进继续写） |
| 有 | 是 | 否 | 否 | `pending` | 未完成（等待回收器删除该记录） |

**为什么 `done` 要带「非空」这一条**：主判据是「存在未删除的日志记录」（用户确认口径）；加「非空」是为了让瞬态自洽——空记录本来就会被回收，稳定态下两种判据完全等价，而在回收尚未执行的瞬间不会误报完成。判空必须走 §4.2 的既有文本提取，**不得用裸正则**（裸正则会误判图片/公式型日志为空，进而触发资源清理）。

### 3.3 视图派生

```ts
buildDailyPlanViews(plans: DailyPlan[], ctx: PlanContext): DailyPlanView[]
groupPlansByDate(views: DailyPlanView[]): PlanDateGroup[]      // 按 date 倒序
buildPlanIndex(plans: DailyPlan[]): Map<EntityId, DailyPlan>   // recordId → plan，用于编辑器归属展示
```

`PlanContext` 提供：`recordsById: Map<EntityId, RecordBlock>`、`draftRecordIds: Set<EntityId>`、`assets: Asset[]`。

**历史视图过滤规则**：只显示「该日有计划」的日期（用户明确要求），组内按 `plan.order` 升序。

### 3.4 统计口径（L0，全部确定性）

| 指标 | 公式 | 边界 |
| --- | --- | --- |
| 今日完成度 | `done(today) / total(today)` | `total === 0` → 显示「今天还没有计划」，不显示 0% |
| 近 N 天完成率 | `Σdone / Σtotal`（N = 7 / 30，仅统计有计划的日期） | `Σtotal === 0` → 「暂无数据」 |
| 连续完成天数 | 从最近一个有计划日期向前逐日回溯；**跳过没有计划的日期**；遇到「有计划但未全部完成」则中断 | 见下方口径说明 |
| 学科分布 | 按 `subject` 分组统计 `total / done` | 只统计有计划的学科 |
| 周汇总 | 按 ISO 周（周一为首日，与 `weekRangeLabel()` 一致）分组 | 跨月周归属该周 |
| 月汇总 | 按自然月分组 | — |

**连续完成天数为什么「跳过无计划日」**：多数用户不会每天都列计划，严格口径（无计划即中断）会让这个数字长期为 1。因此采用宽松口径，并在 UI 上标注为「连续完成（仅计有计划的日子）」，避免被误读为「连续学习天数」——后者已由复习的「连续复习」承担。

### 3.5 函数签名汇总

```ts
// src/lib/dailyPlan.ts
export const resolvePlanOutcome: (plan: DailyPlan, ctx: PlanContext) => PlanOutcome;
export const isPlanRecordEmpty: (record: RecordBlock, ctx: { assets: Asset[]; draftRecordIds: Set<EntityId>; reviewStatus?: RecordReviewStatus }) => boolean;
export const buildDailyPlanViews: (plans: DailyPlan[], ctx: PlanContext) => DailyPlanView[];
export const groupPlansByDate: (views: DailyPlanView[]) => PlanDateGroup[];
export const buildPlanIndex: (plans: DailyPlan[]) => Map<EntityId, DailyPlan>;

// src/lib/planStats.ts
export interface PlanStats { today: {done:number;total:number}; last7: PlanRate; last30: PlanRate; streakDays: number; }
export interface PlanRate { done: number; total: number; rate: number | null; }
export const derivePlanStats: (plans: DailyPlan[], ctx: PlanContext, today: ISODate) => PlanStats;
export const deriveSubjectBreakdown: (plans: DailyPlan[], ctx: PlanContext) => Array<{subject: Subject; done:number; total:number}>;
export const groupPlansByWeek: (groups: PlanDateGroup[]) => Array<{label:string; done:number; total:number}>;
export const groupPlansByMonth: (groups: PlanDateGroup[]) => Array<{label:string; done:number; total:number}>;
```

---

## 4. 存储层设计（`src/services/storageAdapter.ts`）

### 4.1 接口

```ts
async listDailyPlans(date?: ISODate): Promise<DailyPlan[]>;
// 语义与 listBlocks 对齐：过滤软删除；按 date 升序 + order 升序。
// 不传 date 返回全部未删除计划。

async getDailyPlan(id: EntityId): Promise<DailyPlan | undefined>;

async saveDailyPlan(plan: DailyPlan): Promise<DailyPlan>;
// 内部：touch() → markCloudSyncMutation() → db.dailyPlans.put()。
// 返回落库后的实体（含新 updatedAt）。

async deleteDailyPlan(id: EntityId): Promise<void>;
// 软删除：写 deletedAt + 更新 updatedAt；不触碰任何日志。
// 复用 deleteBlock 的写法（storageAdapter.ts:1584-1598）。

async linkPlanRecord(planId: EntityId, recordId?: EntityId): Promise<void>;
// 原子写 linkedRecordId。recordId 为 undefined 表示解除关联（回收时使用）。

async reclaimEmptyPlanRecords(options?: { planIds?: EntityId[] }): Promise<EntityId[]>;
// 见 §5.3。返回被回收的记录 id 列表（供日志/调试使用）。
```

### 4.2 空记录判据（唯一需要认真定义的地方）

```
isEmpty =
     正文纯文本为空                       // recordToPlainText(record, assets)（src/lib/recordContent.ts:403）
  ∧  assets.length === 0
  ∧  formulas.length === 0
  ∧  tags.length === 0
  ∧  无决策块                            // 决策块来自正文，被第一条覆盖，显式检查作为双保险
  ∧  recordReviews.get(id)?.status !== "active"
  ∧  recordDrafts 中没有该 id 的行
```

- **标题不参与判空（关键）**：计划记录的标题在被创建时就被写成了计划标题（§5.1，§14 细节 1），所以标题天然非空。若判据把 `title` 算作内容，「点进去不写就返回」会留下一条只有标题的记录并被计为完成，§9 边界 4 立刻失效。因此判据只认**正文/资源/公式/标签/决策块/复习状态/草稿**，`title` 一律忽略。同理，`createRecordFromPlan` 传入 `title` 时**必须绕过 `nextRecordTitle` 的自动命名**（见 §5.1 签名扩展）。
- **必须包含「无本机草稿」**：编辑器返回时会 `flushDraft()` 把编辑中的内容写成 `recordDrafts` 行（`RecordEditorPage.tsx:642-659`，该路径刻意不 await 存储以保持返回不阻塞）。判据里带上这一条，回收器就天然不会与 `flushDraft` 竞态，无需改动编辑器语义。
- **必须走既有文本提取**：`recordToPlainText` 能正确处理公式、资源引用、折叠/高亮块；裸正则会误判。

### 4.3 写操作规则

1. 所有计划相关的写操作必须先 `markCloudSyncMutation()`（`storageAdapter.ts:298`），否则云同步看不到改动。
2. 计划与记录的关联写入（`linkPlanRecord`）与记录保存（`saveBlock`）之间**不引入跨表事务**：先 `saveBlock` 再 `linkPlanRecord`。失败时留下「有记录、未关联」的状态，由回收器后续修复（把孤立记录视为普通日志，不会丢内容）。
3. 删除计划与删除日志之间**不做任何级联**（不变量 I7）。

---

## 5. 生命周期与回收器

### 5.1 成功路径

```
列计划            → saveDailyPlan({date, subject, title, order})
点计划条目        → createRecordFromPlan(plan)
                     ├─ createRecordBlock(date, subject, {title: plan.title, planId: plan.id})
                     ├─ linkPlanRecord(plan.id, record.id)
                     └─ 进入编辑器（isNewRecord = true）
写内容并保存      → saveBlock（既有路径）
                     └─ 含决策块时沿用既有规则：新建日志自动加入复习（RecordEditorPage.tsx:713-714）
返回              → 计划显示「已完成」+ 绿色对号
```

**`createRecordBlock` 签名扩展**（`src/hooks/useAppData.ts:816`，当前标题由 `nextRecordTitle` 自动生成）：

```ts
async (date = todayISO(), subject?: Subject, contentHtml = "<p></p>",
       options?: { title?: string; planId?: EntityId }) => Promise<RecordBlock>
```

新参数为可选对象，既有 4 个调用点无需改动。

### 5.2 未完成路径

```
点进去不写任何内容就返回（含未退出编辑器就杀进程）
  → 记录为空且无草稿
  → 回收器：permanentlyDeleteBlock(recordId) + linkPlanRecord(planId, undefined)
  → 计划回到「未完成」，界面上不留任何痕迹
```

写了内容但没有按保存就返回 → `recordDrafts` 有该记录的行 → 判据视为「不空」→ **不回收**；列表显示 `draft`（未保存），重新打开可继续写。

### 5.3 回收器设计

| 项 | 设计 |
| --- | --- |
| 触发时机 | ① 从计划返回后（`closeRecordInCurrentTab` 之后）；② `DailyPlanPage` 挂载时；③ 应用启动的既有初始化链路 |
| 数据来源 | **直读 Dexie**（`db.blocks.get` / `db.recordDrafts.get`），不用 React 状态，避免 `refresh()` 未完成时读到陈旧数据 |
| 幂等性 | 是。第二次执行时记录已不存在，直接跳过 |
| 代价 | `O(计划数)`，每天个位数；仅对 `linkedRecordId` 有值的计划做一次 `blocks.get` |
| 副作用 | 回收后调用一次 `refresh()`，使计划列表与「最近日志」同步更新 |
| 竞态 | 与 `flushDraft()` 的竞态由「判据含无草稿」消除；与 `refresh()` 的竞态由「直读 Dexie」消除 |

### 5.4 删除语义汇总

| 动作 | 记录 | 计划 | 说明 |
| --- | --- | --- | --- |
| 删除日志 | 软删除（进回收站） | 保留，自动显示未完成 | 不做级联 |
| 清空回收站 | 物理删除 | 保留 | 计划自动显示未完成 |
| 删除计划 | 保留为普通日志 | 软删除 | 记录的 `planId` 保留，归属声明仍可展示 |

---

## 6. 状态与导航设计

### 6.1 `TabMemory.today` 形状

```ts
today: RecordTabState & {
  adaptiveTaskId?: EntityId;
  planOpen?: boolean;                    // 新增：是否打开今日计划页
  planView?: "today" | "history";        // 新增：计划页内视图（不占导航深度）
};
```

### 6.2 深度表

| 界面 | `planOpen` | `recordId` | depth | 渲染 | 页面 key 令牌 |
| --- | --- | --- | --- | --- | --- |
| 首页（今天） | – | – | 0 | `TodayPage` | `dashboard` |
| 今日计划 | `true` | – | 1 | `DailyPlanPage` | `plan` |
| 计划记录 | `true` | `r1` | 2 | `RecordEditorPage` | `plan` |
| 首页记录 | – | `r1` | 1 | `RecordEditorPage` | `dashboard` |
| 教练任务（既有） | – | – | 1 | `AdaptiveReviewPage` | `adaptive` |

`getTabDepth("today")` 改为：

```
recordId  ? (planOpen ? 2 : 1) + referenceDepth
          : planOpen ? 1
          : adaptiveTaskId ? 1
          : 0
```

### 6.3 返回顺序（`popTabDepth("today")`）

1. 有 `recordId` → 清 `recordId`，**保留 `planOpen`** ⇒ 自然回到「今日计划」。
2. 否则有 `planOpen` → 清 `planOpen`。
3. 否则有 `adaptiveTaskId` → 清 `adaptiveTaskId`。
4. 否则不动（触发既有的「再按一次退出」提示）。

**关键收益**：`closeRecordInCurrentTab` 与安卓系统返回键**都不需要改动**——它们都走 `popTabDepth`，第 1 步的行为正好满足「编辑器 → 计划页」的返回语义。

### 6.4 `buildTabPageKey("today")`

```
`${tab}-${depth}-${recordPart}-${screen}`
screen = planOpen ? "plan" : adaptiveTaskId ? "adaptive" : "dashboard"
```

必须把 `screen` 纳入 key：`planOpen` 与 `adaptiveTaskId` 的 depth 都是 1，仅靠 depth 无法区分，否则过渡动画不会在「首页 ↔ 今日计划」之间触发（`App.tsx:241-246` 的 `isSameVisualPage` 依赖这个 key）。

### 6.5 浏览器历史恢复

`src/lib/webNavigationHistory.ts:248` 的 today 分支增加：

```ts
planOpen: optionalBoolean(value.today.planOpen) ?? false,
planView: PLAN_VIEWS.includes(value.today.planView) ? value.today.planView : "today",   // PLAN_VIEWS = ["today","history"]
```

`todayBase` 的初始值同步补上 `planOpen: false` / `planView: "today"`。理由与 `MORE_SUB_ROUTE_VALUES` 的注释一致：只加类型不改校验，会让浏览器后退恢复出非法状态。

### 6.6 网页返回行（不需要新控件）

`App.tsx:1703-1711` 的 `showWebNavigationBack` 在 `depth > 0 && !currentRecord` 时已经为 true，因此**今日计划页在网页版会自动获得全局返回行**，`popCurrentTabDepth` 会走 §6.3 的第 2 步。

但 Android 原生没有返回行，而 `DailyPlanPage` 属于「自带返回控件」的那类页面（与 `AdaptiveReviewPage` 一致）。因此：

- `DailyPlanPage` 自己渲染返回控件（左上角箭头 + 「今天」）。
- 在 `App.tsx:1703-1711` 的抑制条件中补一条 `!(activeTab === "today" && tabMemory.today.planOpen && !currentRecord)`，否则网页版会出现两个返回入口（`App.tsx:99-108` 的注释明确禁止这种重复）。

### 6.7 交互时序

| 用户动作 | 状态变化 | 存储副作用 | 动画 |
| --- | --- | --- | --- |
| 首页点「今日计划」 | `today.planOpen = true` | 无（计划页挂载时触发回收器） | `forward` |
| 点计划条目 | `today.recordId = r1`（`planOpen` 保持） | `createRecordBlock` + `linkPlanRecord` + `markCloudSyncMutation` | `forward` |
| 编辑器返回 | `today.recordId = undefined` | 编辑器侧 `flushDraft()` | `back` |
| 计划页返回 | `today.planOpen = false` | 回收器 | `back` |
| 页内切换「历史」 | `today.planView = "history"`（`planOpen` 不变） | 无 | 无（页内切换，不触发页面过渡） |

---

## 7. 同步、备份与恢复设计

### 7.1 实体映射

| 项 | 值 |
| --- | --- |
| 实体类型 | `"daily-plan"` |
| 键 | `daily-plan:<id>` |
| payload | 整个 `DailyPlan`（经 `sortValue` 稳定化） |
| `deleted` | `Boolean(deletedAt)` |
| 冲突策略 | **实体级二选一**（与 `block` 同级）；不加入 `NON_CONFLICTING_ENTITY_TYPES`，不做字段级三方合并 |
| `PROTOCOL_VERSION` | 不变 |

跨设备同一计划不会自动合并（两台设备各自建计划 = 两个计划行，属预期行为，不做去重）。

### 7.2 载荷与恢复的必改点

| 类型 | 文件:位置 | 改动 |
| --- | --- | --- |
| 类型 | `src/types.ts` | `BackupPayload.dailyPlans?`、`CloudSyncEntityType`、`BackupManifest.counts.dailyPlans?` |
| 快照 | `storageAdapter.ts:2139-2141` | `createCloudSyncSnapshot()` 是 `createSnapshot()` 的一行别名，**改 `createSnapshot`**（:2070-2137：事务表列表 :2073、`Promise.all` :2075、返回 :2090、payload :2109 附近） |
| 快照 | `storageAdapter.ts:2143-2210` `createStreamableSnapshot` | 同上四处 |
| 恢复 | `storageAdapter.ts:2219` 起 `restoreSnapshotData` | 清表 + `bulkPut` + 读取 `snapshot.payload.dailyPlans ?? []` |
| 恢复 | `storageAdapter.ts:2363` `restoreStreamableSnapshot` 的**显式清表清单** | 必须加 `db.dailyPlans.clear()`，否则恢复后残留旧计划 |
| 清库 | `storageAdapter.ts:2396` `clearAll` | 加 `db.dailyPlans` |
| ZIP | `backup.ts:49`（`snapshotToZip`）、`backup.ts:200`（`zipToSnapshot`） | 写入 / 读取 `dailyPlans` |
| 原生流 | `nativeAutoBackupStreamService.ts:58` 附近 | 同上 |
| 云映射 | `cloudSyncModel.ts` `exportCloudSync:322`、`materializeCloudSyncSnapshot:419`、`manifestFor:378` | 加 `daily-plan` 映射、还原、计数 |
| 测试枚举 | `cloudSyncModel.test.ts:176`、`cloudSyncProtocol.test.ts:156` | 实体类型清单加 `"daily-plan"` |

**明确不需要改**：`firestore.rules`（按用户放开）、`cloudSyncModel.ts:91` 的 `isBootstrapOnlyCloudData`（`:91` 已把任何非 `settings`/`tag` 实体判为非 bootstrap）、`assertSnapshotIntegrity`（计划不引用资源）、`exportPrivacy.ts`（计划不含敏感字段）。

### 7.3 同步/备份的分层纪律

- **UI 与回收器**读过滤视图（`listDailyPlans` 过滤软删除）。
- **快照、同步、备份**必须读原始全量（`db.dailyPlans.toArray()`，含软删除行），否则墓碑丢失、删除无法传播。

---

## 8. UI 详细设计

### 8.1 组件树

```
DailyPlanPage
├─ PageHeader
│   eyebrow  = formatChineseDate(今日/所选范围)
│   title    = "今日计划" | "计划历史"
│   titleActions = 视图切换（今日 / 历史）   ← 与 TodayPage 的 titleActions 位置一致
│   actions  = 完成度胶囊 "3 / 5 完成"
├─ 返回控件（左上角，Android 与桌面都需要）
├─ [view === "today"]
│   ├─ 新建计划形态（学科 SubjectPicker + 标题输入 + 添加按钮）
│   └─ 计划列表（PlanRow × N）
└─ [view === "history"]
    ├─ 周期汇总（近 7 天 / 近 30 天完成率 + 连续完成天数）
    ├─ 学科分布
    └─ 按日期分组的历史（DateGroup × N，只有有计划的日期）
```

`DailyPlanPage` 只读 `dailyPlans` / `blocks` / `subjects` / `assets`，不反向依赖其它模块，便于后续整体搬到 Exocortex。

### 8.2 今日视图线框

```
┌──────────────────────────────────────────────┐
│ ‹ 今天                            今日 │ 历史 │   ← 返回 + 视图切换
│ 2026 年 9 月 16 日                           │
│ 今日计划                    3 / 5 完成       │
├──────────────────────────────────────────────┤
│ 学科 [数学 ▾]  计划内容 [________________]  │
│                                  [ 添加计划 ] │
├──────────────────────────────────────────────┤
│ 数学 · 三大计算 660 题第 50 到 60 题          │
│ ○ 未完成                                      │
├──────────────────────────────────────────────┤
│ 英语 · 单词背诵 List 10                       │
│ ✓ 已完成 · 来自日志「英语 List 10」           │
├──────────────────────────────────────────────┤
│ 政治 · 马原第一章 1-3 节                      │
│ ◐ 未保存（上次输入已保留）                    │
└──────────────────────────────────────────────┘
```

### 8.3 计划行状态规范

| 状态 | `outcome` | 图标 | 文案 | 强调色 |
| --- | --- | --- | --- | --- |
| 已完成 | `done` | 实心对号（绿） | `已完成` + 关联日志标题 | `c-green` 600 |
| 未完成 | `pending` | 空心圆 | `未完成` | 次级文本色 |
| 未保存 | `draft` | 半实心圆 | `未保存（上次输入已保留）` | `c-amber` 600 |

「绿色对号」按用户要求使用绿色（进度语义，不是涨跌语义，不涉及红涨绿跌约定）。

**标题显示规则（因「计划标题落到日志标题」而必须明确）**：计划行左侧始终显示 **`DailyPlan.title`**（计划自己的标题，是计划行的稳定身份）。当关联日志被用户改过标题、且与计划标题不一致时，右侧状态区追加 `· 来自日志「{RecordBlock.title}」`；一致或尚无日志时不追加。

理由：计划标题在创建时写入日志标题（见 §14 细节 1），此后两者可能各自演化。若计划行改显示日志标题，用户改日志标题会让计划行的身份漂移，历史统计也会前后不一致；以计划标题为主、日志标题为附注，既稳定又保留事实。

### 8.4 新建计划表单规格

| 项 | 规格 |
| --- | --- |
| 学科 | 复用 `SubjectPicker`（`src/components/SubjectPicker.tsx`），默认值取当前 `TodayPage` 同款默认学科，并**记住本页上次选择**（页内 state，不落库） |
| 标题 | 单行输入，`placeholder="例如：三大计算 660 题第 50 到 60 题"`，**`maxLength=40`**（用户约定：计划标题不宜过长；超过 40 字时拆成同一学科下的多条计划） |
| 提交 | 回车提交 + 「添加计划」按钮；`trim()` 为空时按钮禁用且不报错 |
| 提交后 | 清空标题、保留学科、新计划追加到列表末尾；滑动/淡入一次 |
| 空态 | 「今天还没有计划。列一条，做完就能顺手记下来。」 |
| 键盘 | Android 上输入框聚焦时使用既有的键盘安全区处理（`useKeyboardVisible` / `viewport`） |

### 8.5 历史视图规格

| 区块 | 内容 |
| --- | --- |
| 周期汇总 | 「近 7 天完成率」「近 30 天完成率」「连续完成」三张卡，风格复用 `stats-state-card` 的三列网格 |
| 学科分布 | 按学科的 `done / total` 列表，条形/比例可视化 |
| 日期分组 | 每个日期一个分组：`9 月 16 日 · 3/5`，组内计划行沿用 §8.3 规范 |
| 过滤 | 只显示有计划的日期（用户明确要求） |
| 空态 | 「还没有计划历史。从今天开始列计划，这里会留下记录。」 |

### 8.6 编辑器的「来自计划」标识

`RecordEditorPage` 顶部元信息区（学科 / 日期同排）增加一个只读标签：

```
[来自计划] 数学 · 三大计算 660 题第 50 到 60 题
```

- 数据来源：`planId` → 内存 `planIndex`。
- **只读、不可点击、不改任何保存/评分/复习语义**。
- 计划已被删除时只显示 `[来自计划]`。

### 8.7 响应式与主题

| 项 | 规格 |
| --- | --- |
| 作用域 | 全部视觉规则限定在 `.daily-plan-page` 下 |
| 主题 | 必须同时适配 `reading`（默认）与 `modern` 两个视觉主题；颜色一律走既有 CSS 变量，不写死色值 |
| 窄屏 | 计划行改为两行布局（学科 + 标题一行，状态一行）；表单学科与标题纵向堆叠 |
| 桌面 | 计划列表最大宽度与既有 `primary-workspace-page` 对齐 |

### 8.8 文案表

| 位置 | 文案 |
| --- | --- |
| 页标题（今日） | 今日计划 |
| 页标题（历史） | 计划历史 |
| 完成度胶囊 | `{done} / {total} 完成`；`total === 0` 时不显示 |
| 今日摘要副标题 | 有完成：「今天已经兑现 X 条计划。」；全未完成且有计划：「还有 X 条计划没写日志。」；无计划：「列一条计划，做完顺手记下来。」 |
| 未保存 | 未保存（上次输入已保留） |
| 编辑器标识 | 来自计划 |
| 删除计划确认 | 删除计划不会删除已经写好的日志。 |

---

## 9. 边界与异常矩阵

| # | 情形 | 期望行为 |
| --- | --- | --- |
| 1 | 标题全为空格 | 不允许提交，按钮禁用；不产生空计划 |
| 2 | 同一天同一学科多条计划 | 允许；`order` 递增 |
| 3 | 同一天 100 条计划 | 允许；列表虚拟化不做（数量级不成立），仅保证渲染不卡 |
| 4 | 点进去不写就返回 | 空记录被回收，计划回到未完成 |
| 5 | 写了但没保存就返回 | 草稿保留，显示「未保存」；不回收 |
| 6 | 保存了空内容 | 记录仍空 → 下次回收时机被回收 → 未完成 |
| 7 | 只有图片没有文字的日志 | **不算空**（走既有文本提取 + `assets` 判定），保留并计为完成 |
| 8 | 只有公式的日志 | 同上（`formulas` 判定） |
| 9 | 写完后手动删除日志 | 软删除 → 计划显示未完成；计划本身不动 |
| 10 | 清空回收站 | 记录物理删除 → 计划显示未完成 |
| 11 | 删除计划 | 日志保留为普通日志；`planId` 保留 |
| 12 | 计划日期跨天（凌晨 00:01 打开） | 计划页显示的是**当天**（`todayISO()`）；昨天的计划出现在历史视图 |
| 13 | App 被杀，未退出编辑器 | 启动时回收器兜底清理空记录 |
| 14 | 两台设备各建同一计划 | 两条独立计划行，不合并、不冲突 |
| 15 | 两台设备改同一条计划 | 实体级二选一（与 `block` 一致的既有交互） |
| 16 | 恢复旧 ZIP 后同步 | 计划与其它实体同路径；不新增特殊处理（既有极高风险另案处理） |
| 17 | 恢复进行中 | 编辑器与计划页沿用既有 `useRestoreInProgress` 锁定 |
| 18 | 计划数量很大（多年） | 历史视图按日期倒序，首批渲染 30 个分组，其余折叠展开 |
| 19 | 学科被归档 | 历史计划仍显示原学科名；新建时下拉不含归档学科 |
| 20 | 一个计划被并发兑现两次（双击） | 第二次点开前先查 `linkedRecordId`，已存在则直接打开既有记录，不重复创建 |

---

## 10. 性能

| 项 | 评估 |
| --- | --- |
| `dailyPlans` 规模 | 每天个位数，10 年约 1 万行；远小于 `blocks` |
| 全量加载 | 与 `blocks` 同批在 `refresh()` 中加载，不引入新的阻塞点 |
| 计划页渲染 | `useMemo` + 内存 Map；不新增全表扫描 |
| 回收器 | `O(计划数)`，仅对有 `linkedRecordId` 的计划做一次 `blocks.get` |
| 统计 | 纯函数，输入为已加载数据，无 IO |
| 索引 | 只新增 `dailyPlans` 的 3 个索引，不触发任何既有表重建 |

---

## 11. 测试设计

### 11.1 单元测试

| 文件 | 覆盖点 |
| --- | --- |
| `src/lib/dailyPlan.test.ts`（新） | 五种 `outcome` 组合；`isPlanRecordEmpty` 的六项判据（含图片-only、公式-only 反例）；`groupPlansByDate` 排序与过滤 |
| `src/lib/planStats.test.ts`（新） | 今日完成度、近 7/30 天、连续完成（含跳过无计划日、跨月、中断）；`total === 0` 与「暂无数据」 |
| `src/services/storageAdapter.dailyPlan.test.ts`（新） | CRUD；软删除；`linkPlanRecord` 双向；回收器幂等；回收器不误伤有草稿的记录；`markCloudSyncMutation` 被调用 |
| `src/db/database.migration.test.ts`（改） | 23 → 24 迁移保留既有数据，`dailyPlans` 表可用 |
| `src/lib/tabNavigation.test.ts`（改） | today 的 5 种深度组合与 pop 顺序（编辑器 → 计划页 → 首页） |
| `src/lib/webNavigationHistory.test.ts`（改） | `planOpen` / `planView` 恢复与非法值回退 |
| `src/pages/DailyPlanPage.test.tsx`（新） | 新建、状态图标、历史视图分组、空态、至少一个移动端断言 |
| `src/pages/TodayPage.test.tsx`（改） | 入口按钮现在可用并触发回调 |
| `src/services/cloudSyncModel.test.ts`、`cloudSyncProtocol.test.ts`（改） | 实体类型清单含 `daily-plan`；`exportCloudSync` → `materializeCloudSyncSnapshot` 往返 |
| `src/services/backup.test.ts`（改） | ZIP 往返包含 `dailyPlans` |

### 11.2 e2e（`e2e/daily-plan.spec.ts`，新）

1. 首页点「今日计划」→ 进入计划页 → 返回首页。
2. 列一条计划 → 点条目 → 写内容 → 保存 → 返回计划页 → 出现绿色对号。
3. 列一条计划 → 点条目 → 直接返回 → 计划页显示未完成，且该记录不出现在「最近日志」。
4. 切到历史视图 → 出现该日期分组与完成度。
5. Android 窄屏下表单纵向堆叠、返回键逐层返回（计划记录 → 计划页 → 首页）。

### 11.3 验收命令

```bash
npm run test -- --exclude "**/*.live.test.ts"
npm run test:e2e
npm run test:firebase
npm run build
git diff --check
```

---

## 12. 分期与出口条件

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| P1 | §2 数据设计 + §4.1 的 CRUD | 迁移测试与 CRUD 单测通过 |
| P2 | §3 领域逻辑 + §5 回收器 | `dailyPlan.test.ts` / 回收器单测通过；手工验证「不写即回收」与「写了有草稿不回收」 |
| P3 | §6 导航 + §8.1-8.6 界面 | Android 与桌面各走一遍 §9 的 1-13 号情形；返回层级正确 |
| P4 | §3.4 统计 + §8.5 历史视图 | `planStats.test.ts` 通过；数字与手工核对一致 |
| P5 | §7 同步与备份穿透 | 双设备同步、ZIP 往返、文件夹备份各验证一次 |
| P6 | §11 测试补全 + 全量验收 | §11.3 全部命令通过 |

**P5 完成前，不得对外表述「计划数据不会丢」**——在 P5 之前计划数据不参与备份与同步。

---

## 13. 风险与回滚

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| schema 24 单向，旧版本回装打不开数据（仓库无 `VersionError` 处理） | 高 | 发布说明写明；不静默处理 |
| 回收器误删有内容的记录 | 高 | 六项判据 + §11.1 的反例测试；图片-only / 公式-only 必须覆盖 |
| 导航深度改动破坏返回键与浏览器历史 | 中 | §6 的五处改动必须与 §11.1 的两组导航测试同批提交 |
| 两台设备改同一计划触发二选一弹窗 | 中 | 属既有交互；在历史视图不呈现冲突状态，避免误导 |
| 恢复旧备份后同步的反向墓碑（既有极高风险） | 中 | 计划不新增该路径；P5 复测该场景 |
| 计划行数量增长导致历史视图过长 | 低 | 首批 30 组 + 折叠展开 |
| `createRecordBlock` 签名扩展影响既有调用点 | 低 | 新参数为可选对象 |

**回滚策略**：功能未上线前回滚 = 移除 `version(24)` 之外的 UI 与入口（保留表定义无害）；已上线后回滚 = 只回滚 UI 与入口，**保留 `dailyPlans` 表与 `planId` 字段**，避免数据库版本二次下降。

---

## 14. 已确认细节（2026-09-16 用户拍板）

1. **计划标题落到日志的哪个字段 —— 已确认：落到 `RecordBlock.title`，正文留空。**
   - `createRecordBlock` 调用时传 `title: plan.title`、`contentHtml: ""`。
   - 确认依据：`RecordEditorPage` 的标题是**用户可编辑**的单行 `textarea`（`src/pages/RecordEditorPage.tsx:1046`，`aria-label="记录标题"`，无 `maxLength`），所以写入后用户仍可自由修改日志标题，不存在「写死」问题。
   - 副作用已覆盖：正文留空 → 新建后立即返回仍被回收器判为空（§4.2 第 1 条），不会留下垃圾日志；若改预填正文，会立刻被决策块提取、AI 上下文与知识导出当成学习内容，故明确不预填。
   - 由「标题可编辑」派生出 §8.3 的**标题显示规则**：计划行以 `DailyPlan.title` 为主，日志标题仅在两者不一致时作为附注。

2. **`title` 的长度上限 —— 已确认：UI 限 40 字，数据层不硬校验。**
   - 依据用户原话：「我一般的计划 title 不会写得过长。如果过长的话，我一般会分开，分成两个日志记录条目，也就是同一个学科下可能会有多个计划」。
   - 落地：`DailyPlan.title`（§2.1）与新建表单（§8.4）取 40；`RecordBlock.title` 不设限（既有字段，且用户编辑日志标题时不应被计划规则约束）。
   - 「同一学科多个计划」**无需额外实现**：数据结构本就允许同一天同一学科多行，`order` 递增即可（§9 边界 2），不存在「一学科一天一计划」的唯一约束。
