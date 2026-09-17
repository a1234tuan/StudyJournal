# AI 问答历史对话「日期 / 时间与系统时间不一致」审查报告

- 审查日期：2026-09-14
- 审查范围：`Review -> AI 问答` 的历史聊天抽屉（`.ai-history-drawer`）及同根因的日期展示点
- 审查方式：只读代码审查（**未改动任何代码**）
- 结论：**问题确认存在。** 不是"数据写错了"，而是**写入端统一用 UTC、展示端直接对 UTC 字符串切字符**，缺少本地时区转换。

---

## 一、结论速览

| # | 问题点 | 精确位置 | 严重度 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 历史列表行的时间直接切 UTC 串：`updatedAt.slice(11, 16)` | `src/pages/AiChatPage.tsx:1026` | 高（每次都错） | 确认存在 |
| 2 | 历史列表行的日期回退值也是 UTC 串：`updatedAt.slice(0, 10)` | `src/pages/AiChatPage.tsx:1026` | 高（跨零点会错日期） | 确认存在 |
| 3 | 顶栏范围标签回退值用 `session.updatedAt.slice(0, 10)` 当"日期" | `src/pages/AiChatPage.tsx:586` | 中 | 确认存在 |
| 4 | 范围选择器默认"今天"用 `new Date().toISOString().slice(0, 10)` | `src/components/AiKnowledgeScopePicker.tsx:78, 183` | 中 | 确认存在 |
| 5 | 同一行内"标题时间"是本地、"副标题时间"是 UTC，自相矛盾 | `src/services/aiSessionService.ts:6-9` vs `AiChatPage.tsx:1026` | 高（可直接目视） | 确认存在 |
| 6 | 同根因残留（播客 / 语音 / 音频库 / 备份文件名） | 见第六节 | 低-中 | 确认存在 |

**用户描述的现象可以 100% 复现**：在 UTC+8 下，历史列表显示的时间恒定比手机/电脑系统时间**早 8 小时**；若会话创建于本地 00:00–08:00，连**日期都会显示成前一天**。

---

## 二、根因链路

问题不在存储层，而在"存储层写 UTC + 展示层不做时区转换"的错配。

### 2.1 写入端：所有 `createdAt` / `updatedAt` 都是 UTC

```ts
// src/lib/date.ts:18
export const nowISO = (): ISODateTime => new Date().toISOString();
```

`toISOString()` 按规范始终返回 **UTC**（`...Z`）字符串。AI 会话与会话消息的基础时间字段由它产出：

```ts
// src/lib/entity.ts:8-15
export const createBaseEntity = (): BaseEntity => {
  const now = nowISO();          // ← UTC
  return { id: newId(), createdAt: now, updatedAt: now };
};

// src/lib/entity.ts:17-20
export const touch = <T extends BaseEntity>(entity: T): T => ({ ...entity, updatedAt: nowISO() });
```

保存会话与消息时都会刷新为 UTC：

```ts
// src/services/storageAdapter.ts:2253-2256
async saveAiSession(session: AiChatSession): Promise<AiChatSession> {
  const saved = touch(session);            // ← updatedAt 再次写成 UTC
  await db.aiSessions.put(saved);
  return saved;
}

// src/services/storageAdapter.ts:2275-2277（保存一条消息会顺带顶高会话 updatedAt）
if (session) {
  await db.aiSessions.put({ ...session, updatedAt: nowISO() });   // ← UTC
}
```

**这一层是正确的、也是应该保留的**：UTC 存储便于跨时区 / 云同步比较，排序也没问题（ISO 8601 UTC 串的字典序等于时间序，见 `storageAdapter.ts:2246` 的 `orderBy("updatedAt").reverse()`）。

### 2.2 展示端：直接对 UTC 串切字符，不做时区转换

```tsx
// src/pages/AiChatPage.tsx:1026
{item.scopeTitle ?? item.attachment?.scopeTitle ?? item.sourceDate ?? item.updatedAt.slice(0, 10)}
{" / "}
{item.updatedAt.slice(11, 16)}
```

`updatedAt` 形如 `2026-09-14T07:30:00.000Z`：

- `.slice(0, 10)` → `2026-09-14`（**UTC 日期**，不是本地日期）
- `.slice(11, 16)` → `07:30`（**UTC 时分**，不是本地时分）

UTC+8 下，本地真实时间 `2026-09-14 15:30` 会被显示成 `2026-09-14 / 07:30`。这就是"日期/时间与系统不一致"的直接原因。

### 2.3 同一行内时间自相矛盾（最直观的证据）

会话**标题**在创建时用的是**本地时间**：

```ts
// src/services/aiSessionService.ts:6-9
export const createAiSessionTitle = (date: string, now = new Date()): string => {
  const time = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });  // ← 本地时分
  return `${date} AI 问答 ${time}`;
};
```

但**副标题**用的是 UTC 时分（`AiChatPage.tsx:1026`）。于是历史列表中**同一条记录会同时出现两个相差 8 小时的时间**，例如标题写 `AI 问答 23:30`、副标题写 `15:30`。这既是缺陷证据，也是最容易被用户注意到的表现。

### 2.4 日期部分的来源与"昨天"现象

副标题的日期按优先级取：`scopeTitle` → `attachment.scopeTitle` → `sourceDate` → `updatedAt.slice(0,10)`。

- 对**日期范围会话**，`scopeTitle` 由 `aiKnowledgeScopeTitle` 生成为 `${scope.date} 日志`（`src/services/aiContextService.ts:189-190`），而 `scope.date` 的**默认值**同样来自 UTC 串：

  ```ts
  // src/components/AiKnowledgeScopePicker.tsx:78
  const [scopeDate, setScopeDate] = useState(
    initialScope?.kind === "date" ? initialScope.date : new Date().toISOString().slice(0, 10),  // ← UTC 今天
  );
  ```

  结果：本地 **00:00–08:00** 之间新建的日期范围会话，其日期会落成**前一天**，并写进 `sourceDate`（`src/services/aiSessionService.ts:31`）与标题；此后即使白天再看，也仍是前一天。

- 对**没有 `scopeTitle` 的历史会话**（例如迁移遗留会话），日期会直接落到 `updatedAt.slice(0, 10)`，同样出现"比系统日期早一天"。

> 附带说明：范围选择器传给 `getAiKnowledgeScopeRecords` 的"参考日期"也用了同一 UTC 值（`AiKnowledgeScopePicker.tsx:183`），因此**"最近 7/14/30 天"的计算窗口会整体偏一天**（本地凌晨到早上 8 点之间）。

---

## 三、量化影响

设设备时区为 UTC+8（`Asia/Shanghai`，即国内默认）：

| 本地真实时间 | 存储的 `updatedAt` | 历史列表显示 | 偏差 |
| --- | --- | --- | --- |
| 2026-09-14 15:30 | `2026-09-14T07:30:00.000Z` | `2026-09-14 / 07:30` | 时间早 8h，日期正确 |
| 2026-09-14 23:59 | `2026-09-14T15:59:00.000Z` | `2026-09-14 / 15:59` | 时间早 8h，日期正确 |
| **2026-09-14 02:00** | `2026-09-13T18:00:00.000Z` | **`2026-09-13 / 18:00`** | **时间早 8h，日期早 1 天** |
| 2026-09-14 07:59 | `2026-09-13T23:59:00.000Z` | **`2026-09-13 / 23:59`** | 时间早 8h，日期早 1 天 |

- 时区偏移越大，偏差越大；对 UTC+8 用户是**恒定 -8 小时的系统性偏移**。
- **日期错位只发生在本地 00:00–08:00 创建的会话**（约占一天的 1/3 时间窗口）。这也解释了为什么用户"有时看到日期不一致、有时只是时间不一致"。

---

## 四、为什么现有测试没拦住

1. **`AiChatPage.test.tsx` 完全没有日期/时间断言。**
   唯一涉及历史抽屉的用例（`AiChatPage.test.tsx:336-349`，"keeps the history drawer mounted but inert during its exit"）只校验 `data-motion-phase` / `aria-hidden` / `inert` 等动效属性，不渲染也不校验那一行文案。测试夹具里的 `stamp = "2026-06-22T00:00:00.000Z"`（第 15 行）恰好是 UTC 零点，即使断言了也只会得到 `2026-06-22 / 00:00`，**掩盖了跨时区偏差**。

2. **项目其实早就知道这个坑，也有正确助手，但没被这一路径使用。**
   `src/lib/date.ts` 提供了正确的本地日期转换：

   ```ts
   // src/lib/date.ts:16, 22-23
   export const todayISO = (): ISODate => format(new Date(), "yyyy-MM-dd");
   export const isoDateTimeToLocalDate = (dateTime: ISODateTime): ISODate => toISODate(new Date(dateTime));
   ```

   并且 `src/lib/date.test.ts:6-9` 用一段注释直白地点出了差异：

   ```ts
   it("derives review dates from local time instead of UTC date prefixes", () => {
     expect(isoDateTimeToLocalDate("2026-07-02T16:30:00.000Z")).toBe("2026-07-03");
     expect("2026-07-02T16:30:00.000Z".slice(0, 10)).toBe("2026-07-02");   // ← 正是缺陷写法
   });
   ```

   即：**正确做法已在库中，缺陷写法在同类代码里被"示范"了**，而 AI 会话路径既没调用 `isoDateTimeToLocalDate`，也没有等价的"本地时分"助手。

3. **测试环境没有固定时区。** `vitest.config.ts` 未设置 `TZ`，而 `date.test.ts:7` 的期望值 `2026-07-03` **只在 UTC+8 及以东时区成立**（在 UTC 环境下会失败）。也就是说该断言本身依赖运行机器的时区，属于同类脆弱点。

---

## 五、修复建议

### P0 — 直接修复用户可见的不一致（改动很小）

1. 在 `src/lib/date.ts` 增加本地时分助手（补齐缺失能力），例如：

   ```ts
   export const isoDateTimeToLocalTime = (dateTime: ISODateTime): string => format(new Date(dateTime), "HH:mm");
   ```

2. `src/pages/AiChatPage.tsx:1026` 改为使用本地转换，而不是 `slice`：

   ```tsx
   {item.scopeTitle ?? item.attachment?.scopeTitle ?? item.sourceDate ?? isoDateTimeToLocalDate(item.updatedAt)}
   {" / "}
   {isoDateTimeToLocalTime(item.updatedAt)}
   ```

3. `src/pages/AiChatPage.tsx:586` 的日期回退同样改为 `isoDateTimeToLocalDate(session.updatedAt)`。

### P1 — 消除"默认今天"的 UTC 偏差

4. `src/components/AiKnowledgeScopePicker.tsx:78, 183` → 改用 `todayISO()`。
5. 同根因残留一并替换为 `todayISO()`：
   - `src/pages/KnowledgePodcastPage.tsx:179, 321, 373`
   - `src/features/voiceRecall/VoiceRecallWorkspace.tsx:381`
   - `src/lib/recordings.ts:138` → `isoDateTimeToLocalDate(podcast.createdAt)`

### P2 — 补回归测试与防复发

6. 在 `AiChatPage.test.tsx` 增加断言：用**靠近零点**的 UTC 时间戳（如 `2026-09-13T18:00:00.000Z`）构造会话，断言历史抽屉渲染出**本地**日期与时分（`2026-09-14` / `02:00`），从而锁定行为。
7. 在 `vitest.config.ts` 显式固定 `TZ`（如 `Asia/Shanghai`），让所有时区相关断言确定可复现；否则测试结果会随机器时区漂移。
8. 增加"禁止裸切片日期"的护栏：对 `src` 下非白名单文件匹配 `toISOString().slice(0, 10)` / `updatedAt.slice(` 即失败，防止同类回归（与现有 `uiErrorSurface.test.ts` 的护栏思路一致）。

---

## 六、同根因残留清单

以下均为"用 UTC 串直接当本地日期/时间"的同一根因，建议与 P0 一并处理：

| 位置 | 写法 | 影响 |
| --- | --- | --- |
| `src/pages/AiChatPage.tsx:586` | `session.updatedAt.slice(0, 10)` | 顶栏范围标签日期偏差，凌晨落成前一天 |
| `src/pages/AiChatPage.tsx:1026` | `updatedAt.slice(0, 10)` / `.slice(11, 16)` | **主问题**：历史列表日期/时间偏差 |
| `src/components/AiKnowledgeScopePicker.tsx:78, 183` | `new Date().toISOString().slice(0, 10)` | 默认"今天"及其"最近 N 天"窗口在本地凌晨偏一天 |
| `src/pages/KnowledgePodcastPage.tsx:179, 321, 373` | 同上 | 知识播客的范围解析参考日期偏一天 |
| `src/features/voiceRecall/VoiceRecallWorkspace.tsx:381` | 同上 | 语音复述取记录时的参考日期偏一天 |
| `src/lib/recordings.ts:138` | `podcast.createdAt.slice(0, 10)` | 音频库中播客"记录日期"偏一天 |

**低优先级、但同源的命名类用法**（影响文件名日期，本地凌晨会写成前一天）：

- `src/services/backup.ts:217`、`src/services/knowledgeExportService.ts:172, 188, 194, 202`
- `src/services/streamingBackupService.ts:26`（`study-journal-<日期>.zip`）
- `src/services/recordTransferService.ts:40`（`study-journal-records-<日期>.zip`）

**明确不是缺陷、不要改动**：

- `src/lib/tencentSigning.ts:56` 的 `toISOString().slice(0, 10)` —— 对象存储签名协议**要求 UTC 日期**，属规范正确用法。
- `src/lib/entity.ts` / `storageAdapter.ts` 的 UTC 写入 —— 存储层保持 UTC 是**正确设计**，不要改成写入本地时间（会破坏跨时区与云同步一致性）。修复只应发生在**展示层与"本地今天"语义层**。

---

## 七、验证方法（不落盘即可复现）

1. **最小目视复现**：把系统时区设为 `UTC+8`，在本地 **02:00** 新建一个 AI 问答会话并发送一轮消息，打开历史抽屉 —— 该条目的时间会显示为约 `18:00`、日期为**前一天**。
2. **对照复现**：同一会话的**标题**时间（本地生成）与**副标题**时间（UTC 切片）相差 8 小时，可在同一行内直接对照。
3. **代码级验证**：对任一 `updatedAt` 为 `2026-09-13T18:00:00.000Z` 的会话，`slice` 结果为 `2026-09-13 / 18:00`，而 `isoDateTimeToLocalDate` + 本地时分助手应为 `2026-09-14 / 02:00`。

---

## 八、边界与不变式（本次修复不应触碰）

- **不改动**存储层时间语义：`createdAt` / `updatedAt` 继续写 UTC。
- **不改动**数据库 schema（当前 21）与云同步契约：`aiSessions` 索引 `"id, sourceDate, updatedAt, createdAt"` 维持原样（`src/db/reviewCoachSchema.ts:25`）。
- **不改动** `pushAdmin` 之外的会话排序逻辑（`storageAdapter.ts:2246` 的 `orderBy("updatedAt").reverse()` 在 UTC 下排序正确）。
- 修复应限定在 `src/lib/date.ts`（新增助手）+ 上述展示点调用方 + 测试。
