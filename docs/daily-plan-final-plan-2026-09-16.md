# 「今日计划」最终可执行方案（2026-09-16 · 定稿）

> **本文地位：唯一权威、可直接开工的方案。** 取代以下三份前序文档中的相应章节：
> - `docs/daily-plan-implementation-plan-v3.md`（可执行实施方案 v3）
> - `docs/daily-plan-detailed-design-2026-09-16.md`（详细设计 LLD）
> - `docs/audit/daily-plan-design-reaudit-2026-09-16.md` 与 `...-second-audit-recheck-2026-09-16.md` 的修订清单（R-1…R-12 / S-1…S-6 已全部并入本文，见 §13 台账）
>
> 上游（不变）：需求 `docs/daily-plan-intent-2026-09-16.md` → 治理 `docs/studyjournal-scope-unfreeze-2026-09-16.md`。
> 核对基线：Dexie schema 23（`src/db/reviewCoachSchema.ts:130`），2026-09-16 逐条回源码核对。
> **本文仍不含代码改动**；§10 是逐文件、带锚点与验收标准的执行清单。
>
> **2026-09-17 修订**：D1 与 D7 中面向 Exocortex 的表述已按 `docs/studyjournal-scope-unfreeze-2026-09-17.md` 修订——原定留给 Exocortex 的 L2（计划元数据 × AI 反馈）改为**在本仓库开发**，可剥离约束保留但动机改为模块边界纪律。§1–§14 的其余技术结论（数据设计、回收器、导航、同步、测试、执行清单）**全部不变**；L2 本身尚无设计，不在本文范围内。

---

## 0. 一句话说明

在既有「日志」之上加一层**意图声明**：用户按学科列出当天计划 → 计划可被兑现为一条**完全等价的普通日志** → 计划行长期保留用于完成度统计与历史。**完成度是派生的，不落库**；**未兑现的过程不留痕**；**删除永不级联**。

---

## 1. 锁定的决策（不再讨论）

| # | 决策 | 来源 |
| --- | --- | --- |
| D1 | 落地在 StudyJournal 本仓库（已获定向解冻），做「计划 + 日志 + 统计」（L0）。**2026-09-17 修订**：AI 联动（L2）原定「留给 Exocortex」，现改为同样在本仓库开发，见 `docs/studyjournal-scope-unfreeze-2026-09-17.md` | 用户 2026-09-16 / 2026-09-17 |
| D2 | 「完成」= **存在未删除的日志记录**；次日结算不解析正文 | 用户 |
| D3 | **不预生成日志**；点开并保存时才创建 → 无草稿态守卫、无定时清理任务 | 用户 |
| D4 | 计划标题 → **`RecordBlock.title`，正文留空** | 用户 |
| D5 | `title` **UI 限 40 字，数据层不校验**；超长拆成同一学科的多条计划 | 用户 |
| D6 | 「今日计划」入口复用 `TodayPage` 既有按钮，**不新建导航层级以外的页面** | 本文 |
| D7 | 计划功能模块保持可整体剥离（只读 `dailyPlans`/`blocks`/`subjects`/`assets`，不反向依赖）。**2026-09-17 修订**：动机由「便于迁 Exocortex」改为**模块边界纪律**，约束本身不变 | 用户 |
| D8 | **删除一条已兑现的日志（软删除进回收站）→ 计划行保留，派生为未完成**；不写任何数据 | 用户 2026-09-16 |
| D9 | **删除一个计划行 → 已兑现的日志保留为普通日志，归属标签也保留**（含学科与计划标题） | 用户 2026-09-16 |

**仍然冻结、本文不碰**：`复习 → 学习助教` 路由；既有任何表的索引；同步协议版本；原生插件依赖；`firestore.rules`。

### 1.1 两条决策的完整后果（实现前必读）

D8 与 D9 都是**「永不级联」**（I7）的直接体现。落实时它们各带出若干必须一起实现的细节：

**由 D8（删日志 → 计划派生未完成）派生的：**

| # | 后果 | 处理 |
| --- | --- | --- |
| 8-a | `linkedRecordId` **不清空** | 这是 D8 能"自动恢复"的前提：从回收站还原日志后，计划自动回到已完成（对比旧稿会因清空关联而永久显示未完成） |
| 8-b | 今日与历史的完成度**同步下降**，且历史某天的分组数会被追溯改写 | 符合 D2（完成度派生自当前事实）。UI 文案用「已兑现 X / 共 Y 条」，不用「完成率 N%」这类客观化措辞（§3.4） |
| 8-c | 计划行看起来与「从未兑现」完全一样 | **本文定的默认**：在状态区加一条浅色提示 「日志已删除」，不改 `outcome` 枚举（仍是 `pending`）、不改数据。数据来源：`linkedRecordId` 有值但记录缺失或 `deletedAt` 有值。目的：避免"我明明写过"的困惑，并把"去回收站还原"这条路径变得可发现。**不需要则一行删掉** |
| 8-d | 用户想「重做」这条计划：点计划行 → 记录已软删除 → 按 §5.4 **新建记录并覆盖 `linkedRecordId`** | 正确行为。旧记录留在回收站；若之后又把它还原，它就变成一条普通日志（`planId` 仍在，归属标签仍显示），计划则指向新记录。**这是接受的后果，不做自动重新关联** |
| 8-e | 删除日志会顺带把它移出复习队列 | **既有行为**（`storageAdapter.ts:1594-1596` 把 `recordReviews.status` 置为 `removed`），非本次新增；在此记录以免被误当成 bug |
| 8-f | 别的设备也要跟着变成未完成 | 无需额外工作：`deleteBlock` 已 `markCloudSyncMutation()`，`deletedAt` 随增量同步传播 |

**由 D9（删计划 → 日志与标签都保留）派生的：**

| # | 后果 | 处理 |
| --- | --- | --- |
| 9-a | `RecordBlock.planId` **不清除**；`deleteDailyPlan` 只软删除计划行本身 | 已在 I7 / §5.5 |
| 9-b | **归属标签要显示完整信息（学科 + 计划标题），而计划行已被软删除** → 只读过滤视图的 `planIndex` 查不到它 | **必须新增 `listDeletedDailyPlans()`**，并把 `planIndex` 建自「未删除 + 已删除」两份（§4.1 / §4.4）。这与仓库既有的 `listBlocks()` / `listDeletedBlocks()` 成对模式一致 |
| 9-c | 标签要标明计划已不存在，否则会让人以为计划还在 | **本文定的默认**：计划仍存在 → `[来自计划] 数学 · 三大计算 660 题`；计划已软删除 → `[来自计划·已删除] 数学 · 三大计算 660 题`。只改一个后缀，不改数据结构 |
| 9-d | 标签在**记录页的浏览与编辑两种模式都要显示** | `renderRecordPage`（`App.tsx:1001`）是**单一定义**，被 5 处调用（`:1051/:1352/:1383/:1491/:1555`）。标签实现在 `RecordEditorPage` 内部即可覆盖全部入口——**只需加一个 prop，不需要改 5 个调用点** |
| 9-e | 软删除的计划行会长期留在库里（没有清理任务），所以标签永远查得到 | 这是**特性不是缺陷**。若将来新增计划行的物理清理，标签会优雅降级为 `[来自计划]`（§8.5） |
| 9-f | 删除计划**不会**改变任何完成度分母之外的东西 | 计划从分母里消失（`done` 与 `total` 同时减去），所以它不能被用来"提高完成率"，但会改变显示的数字 |
| 9-g | 删除计划时给出的确认文案要如实说明 | 见 §8.7 文案表 |

---

## 2. 数据设计（最终）

### 2.1 `DailyPlan`

```ts
// src/types.ts（新增；位置紧邻 RecordBlock）
export interface DailyPlan extends BaseEntity {
  date: ISODate;                 // 本地日历日，只用 todayISO()/addDaysISO()
  subject: Subject;              // 自由字符串；归档后仍按原值显示，不查配置
  title: string;                 // 计划内容；UI 限 40 字，数据层不校验
  order: number;                 // 同日内排序；新建 = 当日最大 order + 1
  linkedRecordId?: EntityId;     // 兑现后写入；仅在「物理回收该记录」时清空
}
```

**刻意不存在的字段**：`status` / `completedAt` / `abandoned` / `autoAddToReview` / `reviewKind` / `subjectId`（用字符串，不用外键）。

### 2.2 `RecordBlock` 追加一个字段

```ts
planId?: EntityId;               // 归属声明：这条日志来自哪个计划
```

- **两边都存的理由**：`DailyPlan.linkedRecordId` 是「计划 → 记录」的**判定真源**（列表直接判定，无需索引）；`RecordBlock.planId` 是**记录自身的归属声明**，在计划行被删除后仍然成立，并随内容一起流动（导出、记录互通，以及将来任何形式的数据迁移）。
- **真源约定**：完成判定只读 `linkedRecordId`；`planId` 只用于展示与归属查询。
- **哈希影响**：`planId === undefined` 不进入稳定 JSON（`cloudSyncModel.ts:130` 的 `sortValue` 显式跳过 `undefined`）→ **既有记录哈希不变**；计划记录首次带 `planId` 上行会改变一次哈希，属正常增量。

### 2.3 schema 24

```ts
// src/db/reviewCoachSchema.ts
export const DAILY_PLAN_SCHEMA_24_STORES = {
  ...REVIEW_COACH_SCHEMA_23_STORES,
  dailyPlans: "id, date, updatedAt, createdAt, linkedRecordId",
} as const;

export const REVIEW_COACH_SCHEMA_VERSION = 24;   // 原 23
```

```ts
// src/db/database.ts
dailyPlans!: Table<DailyPlan, string>;
// 构造函数末尾：
this.version(24).stores(DAILY_PLAN_SCHEMA_24_STORES);
```

沿用仓库「完整 store 映射 + spread 累积」约定，**不在 `database.ts` 内联 store 字符串**。

### 2.4 索引决策（含事实修正）

| 决策 | 理由 |
| --- | --- |
| `date` 建索引 | 今日/历史视图都按日期查询，`where("date").equals()` 是主路径 |
| `linkedRecordId` 建索引 | 「这条记录属于哪个计划」的定向查询与将来的数据修复脚本 |
| `updatedAt` / `createdAt` 建索引 | 与既有表（`templates`、`knowledgePoints` 等）保持同形的约定 |
| **不建 `deletedAt` 索引** | 规模极小（每天个位数、10 年约 1 万行），内存过滤成本可忽略。**注意：理由不是「既有表都不建」——`decisionBlocks` 等表确实索引了 `deletedAt`（`reviewCoachSchema.ts:50-53`）；本文是就本表的规模做的取舍。** |
| **不给 `blocks` 加 `planId` 索引** | `blocks` 已通过 `listBlocks()` 随 `refresh()`（`useAppData.ts:90`）载入内存；加索引会触发大表重建，收益为零 |
| **不使用布尔字段做索引** | IndexedDB 不接受布尔键 |

**索引数 = 4**（`id` 是主键，不计）：`date`、`updatedAt`、`createdAt`、`linkedRecordId`。

### 2.5 不变量与违反时的处理（**已修正：不再有破坏性写**）

| # | 不变量 | 违反时 |
| --- | --- | --- |
| I1 | 一个计划最多关联一条未删除记录 | **不改数据。** 派生为未完成；点击计划时按 §5.4 规则处理 |
| I2 | `linkedRecordId` 只指向未删除的 `type === "record"` | 同上 |
| I3 | 计划记录的 `planId` 等于该计划 id | 不自动修复（以记录为准），仅在归属展示上容错 |
| I4 | `date` 是本地日历日 | 由构造路径保证 |
| I5 | 计划不引用资源、不持有复习状态 | 由类型保证 |
| I6 | 空记录不长期存在 | 由回收器保证（§5.3，且仅在安全观察点执行） |
| I7 | **删除永不级联**：删计划不删日志；删日志不删计划 | 由实现保证 |

> **与旧稿的关键差别**：旧稿的 I1/I2 写「回收器修复：清空 `linkedRecordId`」，这是**破坏性的**——日志被软删除后从回收站恢复，计划将永久显示未完成。现在改为**纯派生**：`linkedRecordId` 只在两处被写（创建记录时写入、物理回收该记录时清空）。

---

## 3. 领域逻辑层（纯函数）

新增两个文件：`src/lib/dailyPlan.ts`（视图派生）、`src/lib/planStats.ts`（统计）。风格对齐既有 `src/lib/learningStats.ts`。

### 3.1 **两个谓词（必须严格区分，这是旧稿最大的歧义）**

```ts
/** 记录里是否有「可读内容」。不含 title（见下），不含草稿与复习状态。 */
export const hasPlanRecordContent = (
  record: RecordBlock,
  ctx: { assets: Asset[] },
): boolean =>
     recordToPlainText(record, ctx.assets).trim() !== ""
  || record.assets.length > 0
  || record.formulas.length > 0
  || record.tags.length > 0;

/** 是否允许把这条记录当作「未兑现的尝试」物理回收。 */
export const canReclaimPlanRecord = (
  record: RecordBlock,
  ctx: PlanContext,
): boolean =>
     !hasPlanRecordContent(record, ctx)
  && !ctx.draftRecordIds.has(record.id)        // 有本机草稿 → 用户有输入，必须保留
  && !ctx.inFlightDraftRecordIds.has(record.id) // 有未落盘的 flush → 现在读到的「空」不可信
  && ctx.reviewStatuses.get(record.id) !== "active"; // 已进复习队列 → 交给复习系统
```

三条硬规则：

1. **`title` 绝不参与判空。** 计划记录的标题在创建时就被写成计划标题，天然非空。若把 `title` 算作内容，「点进去不写就返回」会留下一条只有标题的记录**并被计为已完成**，直接推翻 D2/D3。
2. **不存在「无决策块」这一条。** `recordToPlainText` 已经递归展开决策块内层（`recordContent.ts:293-296`），所以有文字的决策块必然被第 1 条覆盖；而**保留**这条反而会让「只有一个空决策块」的记录被判为「有内容 → 已完成」。空决策块不算内容。
3. **必须走 `recordToPlainText`，禁止裸正则。** 它正确处理公式、资源引用、折叠/高亮块（`:332` 起）；裸正则会误判图片/公式型日志为空，进而触发资源清理。

### 3.2 完成判定 `resolvePlanOutcome`

```ts
export type PlanOutcome = "done" | "pending" | "draft";

export const resolvePlanOutcome = (plan: DailyPlan, ctx: PlanContext): PlanOutcome => {
  if (!plan.linkedRecordId) return "pending";
  const record = ctx.recordsById.get(plan.linkedRecordId);
  if (!record || record.deletedAt) return "pending";        // 记录缺失/已软删除 → 不改数据，直接未完成（D8）
  if (hasPlanRecordContent(record, ctx)) return "done";
  if (ctx.draftRecordIds.has(record.id) || ctx.inFlightDraftRecordIds.has(record.id)) return "draft";
  return "pending";                                        // 空且无草稿 → 等待回收器
};

/** D8 后果 8-c：只驱动一条 UI 提示，不参与 outcome 计算，不写数据。 */
export const isLinkedRecordGone = (plan: DailyPlan, ctx: PlanContext): boolean => {
  if (!plan.linkedRecordId) return false;
  const record = ctx.recordsById.get(plan.linkedRecordId);
  return !record || Boolean(record.deletedAt);
};
```

五态对照（与旧稿等价，但 `done` 只依赖 `hasPlanRecordContent`）：

| `linkedRecordId` | 记录在且未删 | `hasPlanRecordContent` | 有草稿/flush 中 | outcome | UI |
| --- | --- | --- | --- | --- | --- |
| 空 | – | – | – | `pending` | 未完成 |
| 有 | 否 | – | – | `pending` | 未完成 **+ 浅色提示「日志已删除」**（D8 后果 8-c） |
| 有 | 是 | 是 | – | `done` | 已完成 + 绿色对号 |
| 有 | 是 | 否 | 是 | `draft` | 未保存（可点进继续写） |
| 有 | 是 | 否 | 否 | `pending` | 未完成（等待回收器） |

### 3.3 视图派生

```ts
export interface PlanContext {
  recordsById: Map<EntityId, RecordBlock>;
  draftRecordIds: Set<EntityId>;
  inFlightDraftRecordIds: Set<EntityId>;
  reviewStatuses: Map<EntityId, RecordReviewStatus>;
  assets: Asset[];
}

export interface DailyPlanView {
  plan: DailyPlan;
  outcome: PlanOutcome;
  record?: RecordBlock;
  /** D8 后果 8-c：曾经关联过记录、但该记录已缺失或已软删除。只驱动 UI 提示，不影响 outcome。 */
  linkedRecordDeleted?: boolean;
}
export interface PlanDateGroup { date: ISODate; views: DailyPlanView[]; doneCount: number; totalCount: number; }

/** 键 = DailyPlan.id（**不是** recordId）。编辑器用 record.planId 查它。 */
export const buildPlanIndex = (plans: DailyPlan[]): Map<EntityId, DailyPlan> =>
  new Map(plans.map((plan) => [plan.id, plan]));

export const buildDailyPlanViews: (plans: DailyPlan[], ctx: PlanContext) => DailyPlanView[];
export const groupPlansByDate: (views: DailyPlanView[]) => PlanDateGroup[];   // 按 date 倒序
```

- **入参契约**：`plans` **必须是 `listDailyPlans()` 的输出**（已排除软删除）。函数内**不再**二次过滤 `deletedAt`——重复过滤会掩盖调用方漏过滤的 bug，违反 §7.3 的分层纪律。
- 历史视图「只显示有计划的日期」由此自然成立：某日计划全部软删除 → 该日 `total === 0` → 不出现。
- `buildPlanIndex` 按 **plan id** 建键（旧稿 §3.3 与 §8.6 对键的说法不一致，此处定稿为 plan id）：`planId` 稳定，不受「有记录、尚未回填 `linkedRecordId`」的中间态影响。
- **`buildPlanIndex` 的入参必须是「未删除 + 已删除」两份计划**（D9 后果 9-b）：编辑器的归属标签在计划被删除后仍要显示完整的学科与标题，因此它读的是 `planIndex` 而非 `listDailyPlans` 的结果。这是**唯一**允许让软删除数据进入 UI 的地方——它只用于**展示一条既有关联的归属**，绝不进入列表、统计或分母。

### 3.4 统计口径（L0，全部确定性）

| 指标 | 公式 | 边界 |
| --- | --- | --- |
| 今日完成度 | `done(today) / total(today)` | `total === 0` → 显示「今天还没有计划」，不显示 0% |
| 近 N 天完成率 | `Σdone / Σtotal`（N = 7/30，**只统计有计划的日期**） | `Σtotal === 0` → 「暂无数据」 |
| 连续完成天数 | 从最近一个有计划的日期向前**逐日**回溯，跳过没有计划的日期；遇到「有计划但未全部完成」即中断 | 宽松口径 |
| 学科分布 | 按 `subject` 分组 `done / total` | 只统计有计划的学科 |
| 周/月汇总 | 与 `weekRangeLabel()` 一致的 ISO 周（周一为首日）/ 自然月 | 跨月周归属该周 |

**UI 必须标注「连续完成（仅计有计划的日子）」**，避免被误读为「连续学习天数」（后者已由复习的「连续复习」承担）。

**一条必须写进 UI 文案的诚实性约束**：完成率是**派生值**，软删除一条未完成的计划会让它上升。因此文案统一为「已兑现 X / 共 Y 条」，**不要**表述为「完成率 80%」这类客观化措辞。

---

## 4. 存储层（`src/services/storageAdapter.ts`）

### 4.1 接口（加入 `StorageAdapter`，`src/types.ts:998` 起）

```ts
async listDailyPlans(date?: ISODate): Promise<DailyPlan[]>;
// 过滤软删除；按 date 升序 + order 升序。不传 date 返回全部未删除。
// 用于：今日视图、历史视图、一切统计。**不含**软删除行。

async listDeletedDailyPlans(): Promise<DailyPlan[]>;
// 只返回软删除的计划，按 deletedAt 倒序。形态与既有 listDeletedBlocks()（:1600-1605）完全对齐。
// 用途单一：构建 planIndex，让「计划已删除但日志仍在」的记录仍能显示归属（D9 后果 9-b）。
// **绝不**用于列表、统计或任何分母。

async getDailyPlan(id: EntityId): Promise<DailyPlan | undefined>;

async saveDailyPlan(plan: DailyPlan): Promise<DailyPlan>;
// touch() → markCloudSyncMutation() → db.dailyPlans.put()；返回落库实体。

async deleteDailyPlan(id: EntityId): Promise<void>;
// 软删除：写 deletedAt + 更新 updatedAt；**不触碰任何日志，不清任何 planId**（D9）。复用 deleteBlock 写法（:1584-1598）。

async linkPlanRecord(planId: EntityId, recordId?: EntityId): Promise<void>;
// 原子写 linkedRecordId。recordId 为 undefined 表示解除关联（**仅在物理回收时调用**）。

async reclaimEmptyPlanRecords(options?: {
  planIds?: EntityId[];
  skipRecordIds?: EntityId[];        // 有 flush 在途的记录，必须跳过（§5.3）
}): Promise<EntityId[]>;

async permanentlyDeleteBlocks(blockIds: string[]): Promise<void>;
// 批量物理删除：单事务 + 单次 rebuildProjections。permanentlyDeleteBlock 改为委托本方法。
```

`planIndex` 的构建（`useAppData`）：`buildPlanIndex([...dailyPlans, ...deletedDailyPlans])`——**两份合并**，才满足 D9。

### 4.2 写操作规则

1. 所有计划相关写操作**先** `markCloudSyncMutation()`（`storageAdapter.ts:298`，模块级函数），否则云同步看不到改动。
2. 计划与记录的关联**不引入跨表事务**：先 `saveBlock` 再 `linkPlanRecord`。失败时留下「有记录、未关联」，视为普通日志，不丢内容。
3. 删除**永不级联**（I7）。

### 4.3 `permanentlyDeleteBlocks` 的引入（性能修正）

现状：`permanentlyDeleteBlock(id)`（`:1619-1644`）每条都做「跨 ~15 表 rw 事务 + `purgeReviewCoachFactsForRecord` + `cleanupOrphanAssetsForRecord` + **`rebuildProjections()`（:1642，全量重放全部决策块）**」。若一次要回收 5 条空记录，就是 **5 次决策块全量重放**。

```ts
async permanentlyDeleteBlocks(blockIds: string[]): Promise<void> {
  const blocks = (await db.blocks.bulkGet(blockIds)).filter((b): b is Block => Boolean(b));
  if (blocks.length === 0) return;
  await markCloudSyncMutation();
  await db.transaction("rw", [ /* 与 :1629 完全相同的表清单 */ ], async () => {
    for (const block of blocks) {
      const draft = await db.recordDrafts.get(block.id);
      await db.blocks.delete(block.id);
      await db.recordDrafts.delete(block.id);            // ← 关键：草稿随记录一起删除
      await db.studySessions.where("blockId").equals(block.id).delete();
      await db.recordReviews.delete(block.id);
      await db.recordReviewLogs.where("recordId").equals(block.id).delete();
      await db.reviewAnnotationDrafts.where("recordId").equals(block.id).delete();
      if (block.type === "record") {
        await purgeReviewCoachFactsForRecord(db, block.id);
        await this.cleanupOrphanAssetsForRecord(block, draft);
      }
    }
  });
  if (blocks.some((block) => block.type === "record")) {
    await new DexieReviewCoachRepository(db).rebuildProjections();   // ← 只调一次
  }
}

async permanentlyDeleteBlock(blockId: string): Promise<void> {
  await this.permanentlyDeleteBlocks([blockId]);           // 语义不变
}
```

**验收**：既有 `storageAdapter.restore.test.ts` / 回收站相关测试全绿——规则是「单元素批量」与旧逐条行为逐项等价。

### 4.4 回收器的原子判定

```ts
async reclaimEmptyPlanRecords({ planIds, skipRecordIds = [] } = {}) {
  const skip = new Set(skipRecordIds);
  // 注意：这里读的是原始全量（含软删除计划）。原因见下方「软删除计划」说明。
  const plans = (await db.dailyPlans.toArray())
    .filter((p) => p.linkedRecordId && (planIds ? planIds.includes(p.id) : true));
  const candidates = [...new Set(plans.map((p) => p.linkedRecordId!))].filter((id) => !skip.has(id));
  if (candidates.length === 0) return [];

  const reclaimed: EntityId[] = [];
  // 判定与删除放在同一个 rw 事务里：Dexie 对重叠表的 rw 事务串行化，
  // 因此 flushDraft 写 recordDrafts 不可能插在「读草稿」与「删记录」之间。
  await db.transaction("rw", [db.blocks, db.recordDrafts, db.recordReviews, db.dailyPlans], async () => {
    for (const recordId of candidates) {
      const record = await db.blocks.get(recordId);
      if (!record || record.type !== "record" || record.deletedAt) continue;
      const draft = await db.recordDrafts.get(recordId);
      const review = await db.recordReviews.get(recordId);
      const ctx = { assets: await db.assets.toArray() };
      const reclaimable = !hasPlanRecordContent(record, ctx)
        && !draft                       // 事务内重读，不与 flushDraft 竞态
        && review?.status !== "active";
      if (!reclaimable) continue;
      reclaimed.push(recordId);
    }
    if (reclaimed.length > 0) {
      await this.permanentlyDeleteBlocks(reclaimed);                 // 复用 4.3
      // 只为「仍在的计划」回写 linkedRecordId；软删除的计划不必再写（见下）。
      for (const plan of plans.filter(
        (p) => !p.deletedAt && reclaimed.includes(p.linkedRecordId!),
      )) {
        await db.dailyPlans.put({ ...plan, linkedRecordId: undefined, updatedAt: nowISO() });
      }
    }
  });
  return reclaimed;
}
```

**软删除的计划也要参与回收**（D9 的边界）：计划被删除后，它的记录按 D9 保留为普通日志——但如果那条记录**从未写过内容**，它就是一个空壳，仍应被清理，否则会长期出现在「最近日志」里。因此：

- **纳入候选**：软删除计划关联的记录同样接受 `canReclaimPlanRecord` 判定 → 空壳被清掉，有内容的（即"已经兑现的那条日志"）按 D9 保留。
- **不回写计划**：对 `deletedAt` 有值的计划跳过 `dailyPlans.put`，避免在已删除的行上产生无意义的写与同步变更。


- **幂等**：第二次执行时 `blocks.get` 命中不到 → 直接跳过。
- **代价**：`O(计划数)` 次 `blocks.get`，但**一次**事务、**一次** `rebuildProjections()`。
- **返回值**：必须有真实消费者——回收后 `console.debug("[daily-plan] reclaimed …", reclaimed)`（对齐仓库既有的 `[backup]` 前缀诊断风格）。若最终无人消费，改为 `Promise<void>` 并删掉这条注释。

---

## 5. 生命周期与回收器

### 5.1 成功路径

```
列计划      → saveDailyPlan({ date, subject, title, order })
点计划条目  → createRecordFromPlan(plan)
              ├─ createRecordBlock(date, subject, "", { title: plan.title, planId: plan.id })
              ├─ linkPlanRecord(plan.id, record.id)
              └─ 进入编辑器（isNewRecord = true）
写内容保存  → saveBlock（既有路径）；含决策块时沿用既有「新建日志自动加入复习」
返回        → 计划显示「已完成」+ 绿色对号
```

`createRecordBlock` 扩展（`useAppData.ts:816`，**4 个既有调用点 + `addRichTextBlock` 包装 `:881` 全部不受影响**）：

```ts
async (date = todayISO(), subject?: Subject, contentHtml = "<p></p>",
       options?: { title?: string; planId?: EntityId }): Promise<RecordBlock> => {
  …
  title: options?.title ?? nextRecordTitle(normalizedSubject, subjectCount),   // ← 绕过自动命名
  …
  planId: options?.planId,
}
```

**实现期注意**：`createRecordBlock` 自身也内建了「含决策块 → `addRecordToReview`」（`:841-843`），与编辑器路径（`RecordEditorPage.tsx:710-715`）是两条独立入口。计划记录以 `contentHtml: ""` 创建 → 无决策块 → 不会误入复习队列。**这也是「不预填正文」的又一条理由**：预填正文会同时触发两条自动加入路径。

### 5.2 未完成路径

```
点进去不写就返回
  → 记录空、无草稿、无在途 flush
  → 回收器：permanentlyDeleteBlocks([id]) + linkPlanRecord(planId, undefined)
  → 计划回到「未完成」，界面上不留痕迹
```

写了但没按保存就返回 → `recordDrafts` 有该记录的行 → 判据视为不可回收；列表显示 `draft`（未保存），可点进继续写。

### 5.3 回收器的触发时机与竞态（**本文最重要的修正**）

**旧的「从计划返回后即触发」是错的**，会造成用户输入静默丢失。真实时序（已逐行核实）：

```
T1 用户输入后立刻点返回
T2 RecordEditorPage.back()（:642-659）**同步**执行 onBack()（:658）
     —— :653 的注释是刻意的：返回不得依赖存储完成
T3 导航状态变更 → 回收器被触发
T4 回收器直读 Dexie：blocks 里正文仍是空（输入未保存）、recordDrafts 还没有行
     —— **「没有草稿」恰恰是「还没写完」的假象，不是「没有输入」的证据**
T5 判定为空 → 物理删除（permanentlyDeleteBlocks 会连 recordDrafts 一起删，:1631）
T6 flushDraft 此刻才落盘 → 用户输入丢失
```

**修法（三层防护，不使用任何延时）：**

**第 1 层 · 握手（主防护）**：让「有 flush 在途」这个事实变成可查询的内存信号。

`RecordEditorPage` 新增一个**非阻塞**的 prop（不改变返回时机、不改变 flush 行为）：

```ts
onDraftFlushPendingChange?: (recordId: EntityId, pending: boolean) => void;
```

编辑器内部包一层，替换 4 个「`void flushDraft(...)`」调用点（`:325`、`:453`、`:457`、`:466`、`:651`）：

```ts
const flushDraftDetached = useCallback((nextDraft?: RecordBlock) => {
  const id = record.id;
  onDraftFlushPendingChange?.(id, true);
  return flushDraft(nextDraft).catch(() => undefined)
    .finally(() => onDraftFlushPendingChange?.(id, false));
}, [flushDraft, onDraftFlushPendingChange, record.id]);
```

`App.tsx` 持有 `inFlightDraftRecordIdsRef: MutableRefObject<Set<EntityId>>`，通过该 prop 增删，并把集合作为 `skipRecordIds` 传给回收器。布尔即可（同一记录的两次 flush 内容相同，先落盘的那次就已经让 `recordDrafts` 有行，第 3 层会兜住）。

**第 2 层 · 只在安全观察点触发**：删除触发点里的「返回时立即执行」，改为三个安全点：

| 观察点 | 为什么安全 |
| --- | --- |
| ① 编辑器返回的 flush settle 之后（即 `pending` 变为 `false` 的瞬间） | 该记录的 flush 已完成，`recordDrafts` 可读 |
| ② `DailyPlanPage` 挂载时 | 挂载 ⇒ 编辑器未挂载（App 的 today 分支是互斥渲染）；且受第 1 层过滤 |
| ③ 应用启动初始化链路 | 进程重启 ⇒ 所有 flush 必然已 settle，此时读 `recordDrafts` 是可靠的（兜住「写一半被杀」） |

**第 3 层 · 原子事务**：§4.4 把「读记录/读草稿/读复习状态」与「删除」放进同一个 rw 事务。Dexie 对重叠表串行化，因此 `flushDraft` 的写入不可能插在读取与删除之间。

**明确禁止的修法**（都已被评估并否决）：`await flushDraft()`（撞上 `RecordEditorPage.tsx:653` 的既有决策）；`setTimeout`/`sleep`（flaky 反模式，IndexedDB 延迟无上界）。

### 5.4 点击计划条目的规则（替代旧的「清空 `linkedRecordId`」）

```
点计划条目：
  命中 plan.linkedRecordId 且该记录存在且未软删除 → 打开既有记录（不新建）
  否则                                          → 新建记录并覆盖 linkedRecordId
```

**收益**：① 顺带解决「双击并发兑现」（不需要乐观锁，也不需要 UI 防抖）；② 日志被软删除后从回收站恢复 → 计划**自动**回到已完成（旧稿会因清空关联而永久显示未完成）。

此外仍需一道页内防抖：`openingPlanIds: Set<EntityId>`（页内 state），进入时命中即 return，完成后移除。因为导航要等 `createRecordBlock`（内部串了 `listBlocks`/`getSettings`/`saveBlock`/`refresh`/`markAutoBackupDirty`）返回后才发生，列表在整个往返期间仍可点。

### 5.5 删除语义汇总（D8 / D9）

| 动作 | 记录 | 计划 | 归属标签 | 说明 |
| --- | --- | --- | --- | --- |
| **删除日志**（软删除，进回收站） | 软删除；同时移出复习队列（既有行为） | **保留，不写任何数据**；派生为未完成 | 记录不可见，标签不影响 | 不级联。**从回收站还原日志 → 计划自动回到已完成**（因为 `linkedRecordId` 从未被清空） |
| 清空回收站（物理删除日志） | 物理删除 | 保留；仍派生为未完成 | 记录不可见 | `linkedRecordId` 变成悬空值，无害；再点该计划按 §5.4 新建并覆盖 |
| **删除计划**（软删除） | **原样保留**为普通日志 | 软删除 | **完整保留**：`[来自计划·已删除] 学科 · 计划标题`（D9，依赖 `listDeletedDailyPlans`） | 不级联；`planId` 不清除 |
| 计划从未兑现即被删除 | 无 | 软删除 | 无 | — |
| 计划已删除、但关联记录是空壳 | 被回收器清掉（§4.4） | 软删除 | 无 | 空壳不属于 D9 要保留的「已经兑现的那条日志」 |

---

## 6. 导航（三处改动，全部**纯增量**）

### 6.1 `TabMemory.today`（`src/lib/tabNavigation.ts:99`）

```ts
today: RecordTabState & {
  adaptiveTaskId?: EntityId;
  planOpen?: boolean;                    // 新增
  planView?: "today" | "history";        // 新增；不占导航深度
};
```

### 6.2 `getTabDepth`（`src/lib/tabNavigation.ts:233`）

**保持既有分支优先级，只插入 `planOpen`**（不改 `adaptiveTaskId` 的位置，以对齐 `App.tsx:753-757` 安卓返回键的拦截顺序）：

```ts
case "today":
  return memory.today.adaptiveTaskId ? 1
    : memory.today.recordId
      ? (memory.today.planOpen ? 2 : 1) + referenceDepth(memory.today)
      : memory.today.planOpen ? 1
      : 0;
```

| 界面 | `planOpen` | `recordId` | depth | 渲染 | 页面 key 令牌 |
| --- | --- | --- | --- | --- | --- |
| 首页 | – | – | 0 | `TodayPage` | `dashboard` |
| 今日计划 | `true` | – | 1 | `DailyPlanPage` | `plan` |
| 计划记录 | `true` | `r1` | 2 | `RecordEditorPage` | `plan` |
| 首页记录 | – | `r1` | 1 | `RecordEditorPage` | `dashboard` |
| 教练任务（既有） | – | – | 1 | `AdaptiveReviewPage` | `<taskId>` |

`referenceDepth` 是既有函数（`:171`，`state.referenceStack?.length ?? 0`）。

### 6.3 `popTabDepth`（`src/lib/tabNavigation.ts:311`）

在既有三步结构上**插入** `planOpen`，并保留既有的全部字段重置：

```ts
case "today":
  // ① 既有：沉浸式教练任务优先
  if (memory.today.adaptiveTaskId) {
    return { ...memory, today: { ...memory.today, adaptiveTaskId: undefined } };
  }
  // ② 既有：引用栈优先于「清 recordId」（否则引用跳转会整栈被吞）
  {
    const previous = popRecordReference(memory.today);   // 内部从 state 展开 → planOpen 自动保留
    if (previous) return { ...memory, today: previous };
  }
  // ③ 「编辑器 → 计划页」：清 recordId 及全部附属字段，**保留 planOpen / planView**
  if (memory.today.recordId) {
    return { ...memory, today: { ...memory.today,
      recordId: undefined, highlightAssetId: undefined, recordEditing: undefined,
      referenceStack: [], restoreScrollY: undefined } };
  }
  // ④ 离开计划页：连 planView 一起归位，保证下次进入从「今日」开始
  if (memory.today.planOpen) {
    return { ...memory, today: { ...memory.today, planOpen: undefined, planView: undefined } };
  }
  // ⑤ 兜底：保持既有行为（清 recordId 等），额外清计划字段
  return { ...memory, today: { ...memory.today,
    recordId: undefined, highlightAssetId: undefined, recordEditing: undefined,
    referenceStack: [], restoreScrollY: undefined, adaptiveTaskId: undefined,
    planOpen: undefined, planView: undefined } };
```

- 第③步**必须**保留 `highlightAssetId` / `recordEditing` / `referenceStack` / `restoreScrollY` 的重置——只清 `recordId` 会残留 `recordEditing`，让下次从计划进入编辑器直接处于沉浸态（`App.tsx:1688` 用它判 `immersiveTaskActive`）。
- 第②步优先**必须**保留：`referenceStack` 非空时先弹一层引用，直接清 `recordId` 会退出编辑器。
- **收益**：`closeRecordInCurrentTab`（`App.tsx:497` 是一行别名 `popCurrentTabDepth`，`:476` 委托 `popTabDepth`）与安卓返回键的**分派逻辑**都不需要改。

### 6.4 `buildTabPageKey`（`src/lib/tabNavigation.ts:301`）

```ts
return `${tab}-${depth}-${recordPart}-${memory.today.planOpen ? "plan" : memory.today.adaptiveTaskId ?? "dashboard"}`;
```

**必须保留 `adaptiveTaskId` 本身作为令牌**（既有行为是 `${...}-${adaptiveTaskId ?? "dashboard"}`）。若换成字面量 `"adaptive"`，「任务 A → 任务 B」的 key 会变成同一个，`isSameVisualPage`（`App.tsx:241-246`）判定为同页 → 过渡动画不触发。

同时必须加 `plan`：`planOpen` 与 `adaptiveTaskId` 的 depth 都是 1，仅靠 depth 无法区分「首页 ↔ 今日计划」。

### 6.5 浏览器历史恢复（`src/lib/webNavigationHistory.ts:248`）

```ts
today: {
  ...todayBase,
  adaptiveTaskId: isObject(value.today) ? optionalString(value.today.adaptiveTaskId) : undefined,
  planOpen: isObject(value.today) ? optionalBoolean(value.today.planOpen) ?? false : false,
  planView: isObject(value.today) && PLAN_VIEWS.includes(value.today.planView as PlanView)
    ? value.today.planView as PlanView : "today",
},
```

并在 `todayBase` 的初值（`defaults.today`）补上 `planOpen: false` / `planView: "today"`。

**为什么不加在 `restoreRecordState`**：它在 `:182-198` 是**白名单**（只还原 `recordId`/`highlightAssetId`/`recordEditing`/`referenceStack`/`restoreScrollY`）；`adaptiveTaskId` 也是在 `:248` 的显式分支里处理的。只加类型不加校验，会让浏览器后退恢复出非法状态——这与 `MORE_SUB_ROUTE_VALUES` 的注释同因。

### 6.6 网页返回行（`src/App.tsx:1703-1711`）

`showWebNavigationBack` 在 `depth > 0 && !immersiveTaskActive && !currentRecord` 时已为 true，**今日计划页在网页版会自动获得全局返回行**（`popCurrentTabDepth` 走 §6.3 第④步）。

但 `DailyPlanPage` 属「自带返回控件」的页面（与 `AdaptiveReviewPage` 同类，参照 `App.tsx:99-101` 注释：`The global web back row must be suppressed for these, otherwise two competing back affordances appear`）。因此补一条抑制：

```ts
&& !(activeTab === "today" && tabMemory.today.planOpen && !currentRecord)
```

### 6.7 `App.tsx` 其余接线

```tsx
// today 渲染分支（在既有 adaptiveTaskId / currentRecord 之后插入）
: tabMemory.today.planOpen
  ? <DailyPlanPage
      plans={app.dailyPlans}
      planView={tabMemory.today.planView ?? "today"}
      onSwitchView={(view) => updateNavigationState((s) => ({ ...s,
        tabMemory: { ...s.tabMemory, today: { ...s.tabMemory.today, planView: view } } }), "replace")}
      onBack={() => popCurrentTabDepth()}
      onOpenPlan={(plan) => void openRecordFromPlan(plan)}
      onAddPlan={(subject, title) => void app.saveDailyPlan(...)}
      onDeletePlan={(id) => void app.deleteDailyPlan(id)}
      subjects={app.activeSubjects}
      subjectConfigs={app.subjects}          // 历史视图显示已归档学科名
    />
  : <TodayPage … onOpenDailyPlan={openDailyPlan} … />
```

**两条硬性约束（写进代码注释）**：

1. **打开/关闭计划页必须走 `commitNavigation` / `updateNavigationState`，禁止直接调 `setTabMemory`。** `setTabMemory`（`:253`）只是 `commitNavigation` 内部的一行（`:336`）；绕过它会同时破坏四件事：web 历史 push/replace（`:306-330`）、`setNavigationMotion`（`:334`）、**`navigationStateRef.current`（`:333`）**、`setActiveTab`（`:335`）。其中 `navigationStateRef` 陈旧会让 `popCurrentTabDepth`（`:466`）与安卓返回键（`:763`）读到过期状态。
2. **计划的打开/关闭一律显式传 `motion: "forward"` / `"back"`**，与 §6.8 的时序表一致。

**计划按钮接线**：`TodayPage.tsx:25/:49/:83-84` 已有 `onOpenDailyPlan` prop 与按钮，`App.tsx` 从未传入——只需补一个回调（走 `commitNavigation(..., { history: "push", motion: "forward" })`）。

### 6.8 交互时序

| 用户动作 | 状态变化 | 存储副作用 | 动画 |
| --- | --- | --- | --- |
| 首页点「今日计划」 | `planOpen = true` | 无（计划页挂载触发回收器） | `forward` |
| 点计划条目 | `recordId = r1`（`planOpen` 保持） | `createRecordBlock` + `linkPlanRecord` + `markCloudSyncMutation` | `forward` |
| 编辑器返回 | `recordId = undefined` | 编辑器侧 `flushDraft`；settle 后触发回收器 | `back` |
| 计划页返回 | `planOpen = undefined`、`planView = undefined` | 回收器 | `back` |
| 页内切「历史」 | `planView = "history"` | 无 | 无（页内切换） |

---

## 7. 同步、备份与恢复

### 7.1 实体映射

| 项 | 值 |
| --- | --- |
| 实体类型 | `"daily-plan"`（全库实体类型均为 kebab-case，且与表名不同形——例如 `recordReviews` ↔ `"review-state"`） |
| 键 | `daily-plan:<id>` |
| payload | 整个 `DailyPlan`（经 `sortValue` 稳定化） |
| `deleted` | `Boolean(deletedAt)` |
| 冲突策略 | **实体级二选一**（与 `block` 同级）；**不**加入 `NON_CONFLICTING_ENTITY_TYPES`（`:106`，那里只有 `review-state`/`review-day-stat`/`settings`/`template`） |
| `PROTOCOL_VERSION` / `manifest.version` | **都不变**。`BackupPayload.dailyPlans?` 是可选字段：旧版读新快照会忽略未知字段，新版读旧快照得到 `undefined` → `?? []` |

### 7.2 必改点（**已按源码逐条修正**）

| # | 文件:位置 | 改动 |
| --- | --- | --- |
| 1 | `src/types.ts:781-797` `BackupPayload` | `dailyPlans?: DailyPlan[];` |
| 2 | `src/types.ts:760-…` `BackupManifest.counts` | `dailyPlans?: number;` |
| 3 | `src/types.ts:817-843` `CloudSyncEntityType` | `| "daily-plan"` |
| 4 | `src/services/storageAdapter.ts:2070` `createSnapshot` | 事务表清单加 `db.dailyPlans`；`Promise.all` 加 `db.dailyPlans.toArray()`；返回与 payload 各加 `dailyPlans` |
| 5 | `src/services/storageAdapter.ts:2143` `createStreamableSnapshot` | 同上 |
| 6 | `src/services/storageAdapter.ts:2213` `restoreSnapshotData` | 事务表清单加 `db.dailyPlans`；**按 §7.3 的条件语义**清表与 `bulkPut` |
| 7 | `src/services/storageAdapter.ts:2325` `restoreStreamableSnapshot` | 事务表数组（`:2364`）与清表清单（`:2366`）按 §7.3 处理；`bulkPut` 加 `dailyPlans` |
| 8 | `src/services/cloudSyncModel.ts:322` `exportCloudSync` | `mapEntities("daily-plan", snapshot.payload.dailyPlans ?? [])` |
| 9 | `src/services/cloudSyncModel.ts:419` `materializeCloudSyncSnapshot` | `dailyPlans: values<DailyPlan>(entities, "daily-plan")` |
| 10 | `src/services/cloudSyncModel.ts:378` `manifestFor` | `dailyPlans: count("daily-plan")` |
| 11 | `src/services/backup.ts:126` `zipToSnapshot`（payload 对象在 `:194-210`，**逐字段列出**） | `dailyPlans: data.dailyPlans ?? []` |
| 12 | `src/services/cloudSyncService.ts:2057-2059` | **只加注释**：`daily-plan` 有意不加入墓碑排除清单（详见 §7.4） |

**已核实「不需要改」的四处（避免误改）**：

| 位置 | 为什么不用改 |
| --- | --- |
| `storageAdapter.ts:2396` `clearAll` | 它的实现是 **`db.delete()` + `initialize()`**，整库删除，`dailyPlans` 自然包含在内。旧稿写「加 `db.dailyPlans`」是错的 |
| `backup.ts:19-48` `snapshotToZip` | 第 `:24` 行是 `...snapshot.payload` 展开 → 只要类型里有 `dailyPlans?`，**导出侧自动带上**。这里只需补 manifest 计数（若 `manifestFor` 已覆盖则连计数也不用改） |
| `nativeAutoBackupStreamService.ts:51-57` | 同样是 `...snapshot.payload` 展开 → 自动带上 |
| `createCloudSyncSnapshot`（`:2139-2141`） | 它是一行别名 `return this.createSnapshot()`。**只改 `createSnapshot`**，不要动别名 |
| `exportPrivacy.ts` | `stripPrivateExportFields` 是按键名的通用递归过滤；计划不含敏感字段 |
| `assertSnapshotIntegrity`（`:155`） | 计划不引用资源 |
| `firestore.rules` | 按用户整体放开，不列举实体 |

### 7.3 恢复语义：区分「字段缺失」与「空数组」（**防数据丢失**）

**问题**：给恢复流程无条件加 `db.dailyPlans.clear()`，会让**恢复本功能上线前的旧备份**清空本机全部计划（旧快照没有 `payload.dailyPlans` 字段 → 清空后写入空数组）。

**规则**：

```ts
const hasDailyPlansField = Array.isArray(snapshot.payload.dailyPlans);
…
...(hasDailyPlansField ? [db.dailyPlans.clear()] : []),      // 旧快照 → 不清空，保留本机计划
…
if (hasDailyPlansField) await db.dailyPlans.bulkPut(snapshot.payload.dailyPlans!);
```

`restoreSnapshotData`（`:2213`）已在使用条件展开的写法（见 `:2273-2274` 的 `...(options.clearLocalAnnotationDrafts ? [...] : [])`），照抄同一模式即可；`restoreStreamableSnapshot` 同样。

`createSnapshot` / `createStreamableSnapshot` **始终**写入 `dailyPlans`（哪怕是空数组），保证新快照一定带字段。

### 7.4 分层纪律与反向墓碑

- **UI 与回收器**读过滤视图（`listDailyPlans`，排除软删除）。
- **快照、同步、备份**必须读原始全量（`db.dailyPlans.toArray()`，**含软删除行**），否则墓碑丢失、删除无法传播。这与 `listBlocks`（过滤 `deletedAt`）与 `createSnapshot`（用 `db.blocks.toArray()` 全量）的既有分工一致。

**必须记录的既有风险**：`cloudSyncService.ts:2057-2059` 会把「远端有、本地没有」的实体反向标为墓碑（排除清单写死为 `review-state`/`review-day-stat`）。`daily-plan` **有意**走与 `block`/`template` 相同的正常路径——在 `:2057` 附近加注释说明，**不要**把它加进排除清单。后果是：恢复一份旧备份再同步，会删除其他设备上的计划，这与既有各表行为一致，属已知的极高风险路径；**P5 必须专项复测**（§10 T22）。

---

## 8. UI

### 8.1 组件树 `DailyPlanPage`（`src/pages/DailyPlanPage.tsx`，新建）

```
DailyPlanPage
├─ PageHeader
│   eyebrow  = formatChineseDate(今天/所选范围)
│   title    = "今日计划" | "计划历史"
│   titleActions = 视图切换（今日 / 历史）
│   actions  = 完成度胶囊 "3 / 5 完成"
├─ 返回控件（左上角 ‹ 今天；Android 与桌面都渲染）
├─ [view === "today"]
│   ├─ 新建计划表单（SubjectPicker + 标题输入 + 添加按钮）
│   └─ 计划列表（PlanRow × N）
└─ [view === "history"]
    ├─ 周期汇总（近 7 天 / 近 30 天 / 连续完成）
    ├─ 学科分布
    └─ 按日期分组的历史（只有有计划的日期）
```

**数据来源白名单**：只读 `dailyPlans` / `blocks` / `subjects` / `assets` / `recordDrafts`（经 `app.*`），不反向依赖任何其它模块（D7）。`useMemo` + 内存 Map，无新增全表扫描。

### 8.2 计划行状态规范

| 状态 | `outcome` | 图标 | 文案 | 强调色 |
| --- | --- | --- | --- | --- |
| 已完成 | `done` | 实心对号（**绿**） | `已完成` | `c-green` 600 |
| 未完成 | `pending` | 空心圆 | `未完成` | 次级文本色 |
| 未完成（D8：日志已被删除） | `pending` | 空心圆 | `未完成` + 次级浅色提示 `日志已删除` | 次级文本色 |
| 未保存 | `draft` | 半实心圆 | `未保存（上次输入已保留）` | `c-amber` 600 |

`linkedRecordDeleted` 只驱动那一条浅色提示，**不新增 `outcome` 取值、不写数据、不影响统计**（D8 后果 8-c）。它存在的意义：避免用户看到"未完成"时困惑（"我明明写过"），并让"去回收站还原"这条路径变得可发现。

「绿色对号」是**进度语义**（用户明确要求绿色），不涉及红涨绿跌约定。

**标题显示规则**：计划行左侧**始终显示 `DailyPlan.title`**（计划行的稳定身份）。仅当关联日志被改过标题、且与计划标题不一致时，状态区追加 `· 来自日志「{RecordBlock.title}」`；一致或无日志时不追加。

理由：计划标题在创建时写入日志标题，此后两者各自演化。若计划行显示日志标题，用户改日志标题会让计划行的身份漂移、历史前后不一致。

### 8.3 新建计划表单

| 项 | 规格 |
| --- | --- |
| 学科 | 复用 `SubjectPicker`（`src/components/SubjectPicker.tsx`），默认取 `TodayPage` 同款默认学科，并**记住本页上次选择**（页内 state，不落库） |
| 标题 | 单行输入，`placeholder="例如：三大计算 660 题第 50 到 60 题"`，**`maxLength=40`** |
| 提交 | 回车 + 「添加计划」按钮；`trim()` 为空时按钮禁用且不报错 |
| 提交后 | 清空标题、保留学科、新计划追加末尾；淡入一次 |
| 空态 | 「今天还没有计划。列一条，做完就能顺手记下来。」 |
| 键盘 | Android 复用既有键盘安全区处理（`useKeyboardVisible` / `viewport`） |
| 超长 | 输入到 40 字即停；表单下方常驻一行浅色提示「较长的计划可以拆成多条」 |

### 8.4 历史视图

| 区块 | 内容 |
| --- | --- |
| 周期汇总 | 「近 7 天已兑现」「近 30 天已兑现」「连续完成（仅计有计划的日子）」三张卡，复用 `stats-state-card` 三列网格 |
| 学科分布 | 按学科的 `done / total`，条形/比例 |
| 日期分组 | `9 月 16 日 · 3/5` + 组内计划行；**首批渲染 30 个分组**，其余折叠展开 |
| 过滤 | 只显示有计划的日期（D3 派生自然成立，见 §3.3） |
| 空态 | 「还没有计划历史。从今天开始列计划，这里会留下记录。」 |

### 8.5 记录页的「来自计划」标识（D9）

`RecordEditorPage` 顶部元信息区（学科 / 日期同排）加只读标签。**浏览模式与编辑模式都显示。**

| 情形 | 标签 |
| --- | --- |
| 计划仍在 | `[来自计划] 数学 · 三大计算 660 题第 50 到 60 题` |
| 计划已被软删除 | `[来自计划·已删除] 数学 · 三大计算 660 题第 50 到 60 题` |
| 计划已被物理清理（将来可能） | `[来自计划]` |

- 数据来源：`planIndex.get(record.planId)`；`planIndex` 由 `buildPlanIndex([...dailyPlans, ...deletedDailyPlans])` 产出，键为 **plan id**。
- **D9 要点**：计划被删除后标签**仍然显示完整的学科与计划标题**，不降级为裸 `[来自计划]`——这正是 9-b 要求 `listDeletedDailyPlans` 的原因。
- **零额外改动面**：`renderRecordPage`（`App.tsx:1001`）是单一定义、5 处调用（`:1051/:1352/:1383/:1491/:1555`），标签实现在 `RecordEditorPage` 内部即可覆盖全部入口；只需多传一个 prop。
- **只读、不可点击、不改任何保存/评分/复习语义。**

### 8.6 响应式与主题

| 项 | 规格 |
| --- | --- |
| 作用域 | 全部视觉规则限定在 `.daily-plan-page` 下 |
| 主题 | 必须同时适配 `reading`（默认）与 `modern`；颜色一律走既有 CSS 变量，不写死色值 |
| 窄屏 | 计划行两行布局（学科+标题 / 状态）；表单学科与标题纵向堆叠 |
| 桌面 | 列表最大宽度与既有 `primary-workspace-page` 对齐 |

### 8.7 文案表（含 D8 / D9 的如实说明）

| 位置 | 文案 |
| --- | --- |
| 页标题（今日 / 历史） | `今日计划` / `计划历史` |
| 完成度胶囊 | `{done} / {total} 完成`；`total === 0` 时不显示 |
| 汇总卡 | `已兑现 {n} 条` / `共 {n} 条计划`（**不用**「完成率 N%」这类客观化措辞，理由见 §3.4） |
| 今日摘要 | 有完成：`今天已经兑现 X 条计划。`；全未完成且有计划：`还有 X 条计划没写日志。`；无计划：`列一条计划，做完顺手记下来。` |
| 计划行提示（D8） | `日志已删除` |
| 计划行状态 | `未完成` / `已完成` / `未保存（上次输入已保留）` |
| 记录页标签（D9） | `[来自计划] …` / `[来自计划·已删除] …` |
| 新建表单空态 | `今天还没有计划。列一条，做完就能顺手记下来。` |
| 历史空态 | `还没有计划历史。从今天开始列计划，这里会留下记录。` |
| 超长提示 | `较长的计划可以拆成多条` |
| **删除计划确认（D9）** | `删除这条计划？已经写好的日志会保留，日志上的「来自计划」标识也会保留。` |
| **删除日志确认（D8）** | 沿用既有回收站文案，**不改**；计划会自动显示为未完成，不需要额外提示 |

---

## 9. 测试

### 9.1 新建

| 文件 | 覆盖点 |
| --- | --- |
| `src/lib/dailyPlan.test.ts` | 五种 `outcome`；`hasPlanRecordContent` 的**图片-only / 公式-only / 折叠块-only 反例**与「**只有空决策块 ⇒ 无内容**」反例；`title` 不影响判定；**D8：记录软删除/缺失 ⇒ `pending` + `isLinkedRecordGone === true`，且 `title`/`linkedRecordId` 不被改动**；**D9：`buildPlanIndex([...live, ...deleted])` 能用 `planId` 查到已删除计划**；`groupPlansByDate` 排序与过滤 |
| `src/lib/planStats.test.ts` | 今日完成度；近 7/30 天；连续完成（跳过无计划日、跨月、中断）；`total === 0`；**D8：日志软删除后该日 `done` 减 1** |
| `src/services/storageAdapter.dailyPlan.test.ts` | CRUD；软删除；**`listDeletedDailyPlans` 只返回已删除（对照 `listDeletedBlocks` 的形态）**；`linkPlanRecord` 双向；回收器幂等；**回收器不误伤有草稿的记录**；**`skipRecordIds` 生效**；**D9：`deleteDailyPlan` 不触碰 `blocks`、不清 `planId`、不改 `linkedRecordId`**；**D9 边界：软删除计划关联的「空壳记录」会被回收，有内容的记录被保留**；`permanentlyDeleteBlocks` 与逐条等价；每写操作都触发 `markCloudSyncMutation` |
| `src/pages/DailyPlanPage.test.tsx` | 新建、三种状态图标、历史分组、空态、至少一个移动端断言 |
| `e2e/daily-plan.spec.ts` | 见 §9.3 |

### 9.2 修改既有（**已按源码修正**）

| 文件 | 改动 | 必要性 |
| --- | --- | --- |
| `src/services/storageAdapter.restore.test.ts:206-227` | `createRestoreDb()` 必须加 `dailyPlans: new MemoryTable(),` | **必改**。该 mock 以 `vi.doMock("../db/database", () => ({ db: fakeDb }))`（`:369`）整体替换 db，加了 `db.dailyPlans.clear()` 后不补这一行会 `TypeError` |
| `src/hooks/useAppData.decisionBlock.test.tsx:6-42` | `mocks` 必须加 `listDailyPlans: vi.fn().mockResolvedValue([])`（若 refresh 也读草稿还要加 `listRecordDrafts`） | **必改**。该 mock 是未标注类型的普通对象，编译能过但运行时 `refresh()` 会抛 `storage.listDailyPlans is not a function` |
| `src/services/backup.test.ts:39-51` | payload fixture 加 `dailyPlans: []`；新增 ZIP 往返断言 | 需要（P5） |
| `src/services/cloudSyncModel.test.ts:76-88`、`cloudSyncProtocol.test.ts:37-48` | snapshot fixture 加 `dailyPlans: []`；新增 `exportCloudSync` → `materializeCloudSyncSnapshot` 往返断言 | 需要（P5） |
| `src/services/cloudSyncProtocol.test.ts:148-158` | **不改**。该断言是 coach 专属集合（`coachTypes`，`toEqual` 10 项），差集不会产生 `daily-plan` 实体 | 确认不改 |
| `src/db/database.migration.test.ts` | 加 23 → 24 迁移测试：既有数据保留、`dailyPlans` 可用 | 需要（P1） |
| `src/lib/tabNavigation.test.ts` | today 的深度组合与 pop 顺序；**引用栈优先于清 recordId**；`planOpen` 不被 `popRecordReference` 吞掉；页面 key 保留 `adaptiveTaskId` | 需要（P3） |
| `src/lib/webNavigationHistory.test.ts` | `planOpen`/`planView` 恢复与非法值回退 | 需要（P3） |
| `src/pages/TodayPage.test.tsx` | 入口按钮触发回调 | 需要（P4） |

### 9.3 e2e（`e2e/daily-plan.spec.ts`）

1. 首页点「今日计划」→ 计划页 → 返回首页。
2. 列计划 → 点条目 → 写内容 → 保存 → 返回 → 绿色对号。
3. 列计划 → 点条目 → **直接返回** → 显示未完成，且该记录不出现在「最近日志」。
4. **竞态回归（关键）**：列计划 → 点条目 → **在输入框打字后立即点返回** → 计划显示「未保存」而不是「未完成」，且再次进入能看到刚输入的内容。（这条就是 §5.3 的防回归测试。）
5. 历史视图出现该日期分组与完成度。
6. **D8**：兑现一条计划 → 把该日志移入回收站 → 计划行仍在、显示未完成 + 浅色提示「日志已删除」；再从回收站还原该日志 → **自动回到已完成**（证明 `linkedRecordId` 未被清除）。
7. **D9**：兑现一条计划 → 删除该计划行 → 该日志仍留在「最近日志」中，打开后标签显示 `[来自计划·已删除] 学科 · 标题`；学科与标题都还在。
8. Android 窄屏：表单纵向堆叠、返回键逐层返回（计划记录 → 计划页 → 首页）。

### 9.4 验收命令

```bash
npm run test -- --exclude "**/*.live.test.ts"     # 与冻结文档的规范命令逐字一致
npm run test:e2e
npm run test:firebase
npm run build
git diff --check
```

---

## 10. 执行清单（逐文件、带锚点与验收）

> **规则**：同一阶段内的任务按序执行；标 **⛓** 的任务必须在同一批提交里完成（否则编译或测试必红）。

### 阶段 P1 · 数据与存储

| # | 文件 | 动作 | 验收 |
| --- | --- | --- | --- |
| T1 ⛓ | `src/types.ts` | 加 `DailyPlan`（§2.1）；`RecordBlock` 加 `planId?`；`BackupPayload` 加 `dailyPlans?`；`BackupManifest.counts` 加 `dailyPlans?`；`CloudSyncEntityType` 加 `"daily-plan"`；`StorageAdapter`（`:998`）加 §4.1 的 **8 个**方法声明（含 `listDeletedDailyPlans`、`permanentlyDeleteBlocks`） | `tsc -b` 在 T3 完成后通过 |
| T2 ⛓ | `src/db/reviewCoachSchema.ts` | 加 `DAILY_PLAN_SCHEMA_24_STORES`（`:119` 后）；`REVIEW_COACH_SCHEMA_VERSION` `23 → 24`（`:130`） | — |
| T3 ⛓ | `src/db/database.ts` | `dailyPlans!: Table<DailyPlan, string>`；构造函数末尾 `this.version(24).stores(DAILY_PLAN_SCHEMA_24_STORES)`；确认 `initialize()` 的并发合并逻辑不受影响 | `database.migration.test.ts` 通过 |
| T4 | `src/services/storageAdapter.ts` | `permanentlyDeleteBlocks` + `permanentlyDeleteBlock` 委托（§4.3）；`listDailyPlans`/`listDeletedDailyPlans`/`getDailyPlan`/`saveDailyPlan`/`deleteDailyPlan`/`linkPlanRecord`/`reclaimEmptyPlanRecords`（§4.1/§4.4）；每个写操作首行 `markCloudSyncMutation()` | 既有回收站/恢复测试全绿 |
| T5 | `src/services/storageAdapter.ts` | `createSnapshot`（`:2070`）与 `createStreamableSnapshot`（`:2143`）：事务表 + `Promise.all` + 返回 + payload 各加 `dailyPlans` | — |
| T6 | `src/hooks/useAppData.ts` | `refresh()`（`:88`）的 `Promise.all` 加 `storage.listDailyPlans()` 与 `storage.listRecordDrafts()`；暴露 `app.dailyPlans` / `app.recordDrafts` / `app.saveDailyPlan` / `app.deleteDailyPlan`；`createRecordBlock`（`:816`）加 `options`（§5.1） | T4 的测试 + `useAppData.decisionBlock.test.tsx`（同步加 mock，见 §9.2） |
| T7 | `src/services/storageAdapter.dailyPlan.test.ts`（新）、`src/db/database.migration.test.ts`（改）、`useAppData.decisionBlock.test.tsx`（改）、`storageAdapter.restore.test.ts`（改 mock） | 见 §9 | 全绿 |

**P1 出口**：`npm run test -- --exclude "**/*.live.test.ts"` 全绿；`npm run build` 通过。

### 阶段 P2 · 领域逻辑 + 回收器

| # | 文件 | 动作 | 验收 |
| --- | --- | --- | --- |
| T8 | `src/lib/dailyPlan.ts`（新） | §3.1 两个谓词、§3.2 判定、§3.3 派生与索引 | — |
| T9 | `src/lib/dailyPlan.test.ts`（新） | §9.1 | 全绿，**含图片/公式/空决策块三个反例** |
| T10 | `src/pages/RecordEditorPage.tsx` | 加 `onDraftFlushPendingChange?` prop；包出 `flushDraftDetached`（§5.3 第 1 层）替换 `:325`/`:453`/`:457`/`:466`/`:651` 五处调用。**不得改变 `back()` 的同步返回时机，不得 await** | 既有编辑器测试全绿 |
| T11 | `src/App.tsx` | `inFlightDraftRecordIdsRef`；把集合传给 `reclaimPlanRecords` 的 `skipRecordIds`；**三个安全触发点**（编辑器 settle 回调、`DailyPlanPage` 挂载、应用启动）；回收后用 `refresh()` 同步 UI | 手工验证 §5.2 两条路径 + e2e 第 4 条 |

**P2 出口**：手工验证「不写即回收」与「写了有草稿不回收」；**必须**在模拟器上手工复现 §9.3 第 4 条并通过。

### 阶段 P3 · 导航

| # | 文件 | 动作 |
| --- | --- | --- |
| T12 | `src/lib/tabNavigation.ts` | `:99` TabMemory；`:233` `getTabDepth`；`:311` `popTabDepth`；`:301` `buildTabPageKey`（§6.1-6.4） |
| T13 | `src/lib/webNavigationHistory.ts` | `:248` today 分支 + `defaults.today`（§6.5） |
| T14 | `src/App.tsx` | 抑制条件（`:1707` 后）；today 渲染分支加 `planOpen`；`openDailyPlan` 走 `commitNavigation`；today 的 `PageTransition` key | — |
| T15 | `src/lib/tabNavigation.test.ts`、`src/lib/webNavigationHistory.test.ts` | §9.2 | — |

**P3 出口**：`tabNavigation.test.ts` / `webNavigationHistory.test.ts` 全绿；Android 实机走一遍返回链（计划记录 → 计划页 → 首页）。

### 阶段 P4 · UI 与统计

| # | 文件 | 动作 |
| --- | --- | --- |
| T16 | `src/lib/planStats.ts`（新）+ `planStats.test.ts`（新） | §3.4 |
| T17 | `src/pages/DailyPlanPage.tsx`（新）、`src/styles/visual-v2.css`（`.daily-plan-page` 作用域）、`DailyPlanPage.test.tsx`（新） | §8 |
| T18 | `src/pages/TodayPage.tsx`、`src/pages/RecordEditorPage.tsx` | 入口接线（`:83` 已有按钮，只需传 prop）；编辑器「来自计划」标签（§8.5） |

**P4 出口**：`DailyPlanPage.test.tsx` / `planStats.test.ts` 全绿；数字与手工核对一致；`reading` 与 `modern` 两个主题各截图一次。

### 阶段 P5 · 同步与备份

| # | 文件 | 动作 |
| --- | --- | --- |
| T19 | `cloudSyncModel.ts`（`:322`/`:419`/`:378`）、`cloudSyncService.ts:2057`（**只加注释**） | §7.2 #8-#12 |
| T20 | `storageAdapter.ts`（`:2213`/`:2325`） | §7.3 的 `undefined` vs `[]` 语义 |
| T21 | `backup.ts:126`（`zipToSnapshot`） | 加 `dailyPlans`；确认 `snapshotToZip` 与 `nativeAutoBackupStreamService` **无需改** |
| T22 | `backup.test.ts`、`cloudSyncModel.test.ts`、`cloudSyncProtocol.test.ts` | §9.2；并执行 §11 的手工验证 |

**P5 出口**：双设备同步、ZIP 往返、文件夹备份各验证一次（§11）。**P5 完成前不得对外表述「计划数据不会丢」。**

### 阶段 P6 · 全量验收

`npm run test -- --exclude "**/*.live.test.ts"` / `test:e2e` / `test:firebase` / `build` / `git diff --check` 全通过；§9.3 八条 e2e 全通过。

---

## 11. P5 手工验证步骤

**双设备同步**
1. A 建 3 条计划（含 1 条同一天同学科的第二条），兑现 1 条（写入并保存日志）。
2. 同步 → B：3 条齐全、兑现那条绿色对号、日志正文完整。
3. B 兑现第 2 条 → 同步 → A 看到 2/3 已完成。
4. B 删除第 3 条计划 → 同步 → A 上该行消失，**关联日志仍在**（I7）。
5. B 把第 1 条日志移入回收站 → 同步 → A 上该计划回到未完成；**再还原该日志 → 同步 → A 上自动回到已完成**（§5.4 的核心收益）。
6. **反向墓碑专项**：A 恢复一份**本功能上线前**的备份 → 同步 → 按 §7.3 的语义，**本机与其他设备的计划都应保留**。此步必须留档；未通过则功能不得上线。

**ZIP 往返**
1. 导出 → 解压确认 `data.json` 含 `dailyPlans`、`manifest.json.counts.dailyPlans` 与之一致。
2. `clearAll()` → 导入 → 计划条数、`linkedRecordId`、日志 `planId` 全部还原。
3. **旧包兼容**：构造一份不含 `dailyPlans` 的旧 `data.json` → 导入 → **本机计划应被保留**（§7.3）。

**文件夹 / 原生流备份**
1. 触发自动备份 → 确认流式 `data.json` 含 `dailyPlans`（由 `...snapshot.payload` 自动带上）。
2. 删除原文件 → 恢复 → 与 ZIP 第 2 步同校验。
3. 确认恢复后**不残留**本机旧计划（新快照带字段 → 走清空分支）。

---

## 12. 风险与回滚

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| **恢复旧备份清空计划 / 反向墓碑删除云端计划** | **高** | §7.3 的 `undefined` vs `[]` 语义 + §7.4 的注释；**P5 第 6 步必须通过** |
| **回收器误删用户刚输入的内容** | **高** | §5.3 三层防护；e2e 第 4 条为专用回归测试；**禁止 sleep / await 式修法** |
| 回收器误删有内容的记录（图片/公式-only） | 高 | §3.1 判据 + 三个反例单测 |
| schema 24 单向，旧版本回装打不开数据（仓库**无 `VersionError` 处理**） | 高 | 发布说明写明；不静默处理 |
| 导航深度改动破坏返回键与浏览器历史 | 中 | §6 四处改动与两组导航测试同批提交 |
| 两台设备改同一计划触发二选一弹窗 | 中 | 属既有交互；历史视图不呈现冲突状态 |
| 计划行数增长导致历史视图过长 | 低 | 首批 30 组 + 折叠展开 |
| `createRecordBlock` 签名扩展影响既有调用点 | 低 | 新参数为可选对象；已核对 4 个调用点 + `addRichTextBlock`（`:881`）均不受影响 |

**回滚策略（已修正，按「是否已发布到任一设备」分两种情形）**：

| 情形 | 允许的操作 |
| --- | --- |
| schema 24 **从未发布到任何设备**（含网页版用户、真机、桌面版） | 可整体移除 `version(24)`、表声明与 UI |
| schema 24 **已发布到任一设备** | **绝不可**移除 `version(24)`；只能移除 UI 与入口，**表、字段、版本声明全部保留** |

**机制说明**：Dexie 打开数据库时会比对声明版本与本地已存版本；本地 > 声明即抛 `VersionError`，而仓库没有该异常的处理 → 摘掉版本声明会导致**应用连数据都打不开**。

**重新上线时遗留数据的处理**：不需要任何迁移。表在、版本在、行在，重新启用 UI 直接读出即可。

---

## 13. 修订台账（前序审计的 18 条已全部落实）

| 编号 | 来源 | 落实位置 |
| --- | --- | --- |
| R-1 竞态丢数据 | 复核 A + 独立核对 | §5.3 三层防护 + e2e 第 4 条 |
| R-2 空记录误判为已完成（删掉「无决策块」） | 复核 A 第 5 条裁定 | §3.1 规则 2 |
| R-3 双击防护 | 复核 A 第 9 条 | §5.4 in-flight `Set` |
| R-4 `adaptiveTaskId` 保持第一优先 | 独立核对 N-1 | §6.2 |
| R-5 `popTabDepth` 补引用栈 + 完整字段重置 + `planView` 归位 | 独立核对 N-2 | §6.3 |
| R-6 页面 key 保留任务 ID | 独立核对 N-4 | §6.4 |
| R-7 `buildPlanIndex` 键统一为 plan id | 独立核对 N-3 | §3.3 |
| R-8 ①删错误理由 ②索引数 3→4 ③批量回收 ④去掉破坏性清关联 | N-6 / 笔误 / N-8 / N-9 | §2.4 / §2.4 / §4.3 / §5.4 |
| R-9 必改测试点修正（删 `cloudSyncProtocol`、加 `restore.test.ts` 与 `decisionBlock.test.tsx`） | N-7 + 本轮独立核对 | §9.2 |
| R-10 恢复的清表语义 + 反向墓碑 | N-10 | §7.3 / §7.4 |
| R-11 回滚按发布状态分情形 | 复核 A 第 14 条 | §12 |
| R-12 补反例与竞态回归测试 | — | §9.1 / §9.3 |
| S-1 补文件路径 | 复核 B | §6.1-6.4 |
| S-2 写明禁止直接 `setTabMemory` | 复核 B | §6.7 |
| S-3 索引数 4 | 复核 B | §2.4 |
| S-4 `title` 不影响判定的作用域提到判定层 | 复核 B | §3.1 规则 1 |
| S-5 `snapshotToZip` 无需改 | 复核 B | §7.2 「不需要改」表 |
| S-6 保留 P1-P6 分期，不用 P0-P3 | 复核 B | §10 |
| 额外修正 | 本轮独立核对 | `clearAll` 是 `db.delete()`（§7.2）；`nativeAutoBackupStreamService` 无需改（§7.2）；`Set` 而非计时器 |
| D8 | 删日志 → 计划保留、派生未完成（`linkedRecordId` 不清空，可从回收站自动回到已完成） | 用户 2026-09-16 定稿 | §1 / §1.1（8-a~8-f）/ §3.2 / §3.4 / §5.5 / §8.7 / §9.1 / §9.3 |
| D9 | 删计划 → 日志与归属标签都保留（新增 `listDeletedDailyPlans` 支撑标签显示完整学科+标题） | 用户 2026-09-16 定稿 | §1 / §1.1（9-a~9-g）/ §3.3 / §4.1 / §4.4 / §5.5 / §8.5 / §8.7 / §9.1 / §9.3 |

**前序文档状态**：`daily-plan-detailed-design-2026-09-16.md` 与 `daily-plan-implementation-plan-v3.md` 的设计/实施章节自本文起失效，保留作历史记录；两份审计复核报告保留作方法论参考。

---

## 14. 开工前的最后检查（30 秒）

1. `git status` 干净，当前分支 `main`。
2. `npm run test -- --exclude "**/*.live.test.ts"` **先跑一遍基线**，记录既有红/绿，避免把既有失败误算到本次改动上。
3. 确认本机与所有目标设备的 schema 都是 23（**一旦任一设备升到 24 就不可回退**，见 §12）。
4. 从 **T1 ⛓ T2 ⛓ T3** 同批开始。
