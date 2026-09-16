# 「今日计划」详细设计 —— 对「外部审计报告」的复核审计（2026-09-16）

> 被审计对象 1：`docs/daily-plan-detailed-design-2026-09-16.md`（我的详细设计）
> 被审计对象 2：用户转来的「外部 AI 审计报告」（16 条问题 + 5 条亮点）
> 本文的立场：**不预设任何一方正确**，每条断言都回到源码核对。凡我无法在源码中找到证据的，明确标为「未证实」。
> 核对基线：Dexie schema 23（`src/db/reviewCoachSchema.ts:130`）。

---

## 0. 结论摘要

**对该审计报告的总体裁定：16 条里只有 3 条是真正有价值且表述正确的，4 条是明确的事实错误，5 条读的是过期文档或指错方向，其余 4 条是成立但轻微的澄清建议。它漏掉了 10 个比它所列更严重的问题。**

| # | 它的问题 | 裁定 | 一句话理由 |
| --- | --- | --- | --- |
| 1 | I3 与修复策略不一致 | ⚠️ 提问部分成立，**建议错误** | 两个提问在设计里已有答案；它建议「linkPlanRecord 同步 planId」会破坏设计意图 |
| 2 | 回收器与 `flushDraft()` 竞态 | ✅ **成立，且比它说的更严重** | 已核实；后果是用户输入被静默删除，不只是"时序覆盖" |
| 3 | `createRecordBlock` 不存在 | ❌ **事实错误** | `src/hooks/useAppData.ts:816-849` 就在那里，签名与文档一致 |
| 4 | `dailyPlans` 索引缺 `deletedAt` | ❌ **机制性错误** | Dexie 的 store 字符串只定义索引，不定义字段；它引用的反例自相矛盾 |
| 5 | 「无决策块」冗余 | ✅ 观察正确，**建议方向反了** | 确实冗余，但删掉比保留更安全，它推错了结论 |
| 6 | 历史过滤与统计口径 | ⚠️ 成立的澄清项 | `listDailyPlans` 已过滤软删除，补一句话即可 |
| 7 | `referenceDepth` 未定义 | ❌ **基本错误** | `tabNavigation.ts:171` 就是它的既有定义，设计用得对 |
| 8 | 同步实体类型命名不一致 | ❌ **错误，且建议会引入新错误** | 实体类型全库 kebab-case；`recordReviews` 对应 `"review-state"`，不是它说的 `record-review` |
| 9 | 并发双击无防护 | ✅ **成立（中）** | 已核实导航在 IndexedDB 往返之后才发生，双击窗口真实存在 |
| 10 | 测试文件命名不一致 | ❌ **错误** | 既有就是 `storageAdapter.<feature>.test.ts`，设计完全一致 |
| 11 | 回收器返回值用途不明 | ✅ 成立（低） | 要么真写日志，要么改 `Promise<void>` |
| 12 | 性能缺索引大小估算 | ⚠️ 前提有误（3 vs 4），估算本身可选 | 它把设计 §10 的笔误抄了过去 |
| 13 | P5 验证步骤笼统 | ✅ 成立（低） | 已在 §4 给出可直接照做的步骤 |
| 14 | 回滚「保留表定义无害」需验证 | ✅ **成立且重要** | Dexie 会 `VersionError`；但答案和它猜的方向不同 |
| 15 | §14 两个细节应现在确认 | ❌ **过时** | 它读的是更新前的文档；且它建议 80 字与用户已拍板的 40 字冲突 |
| 16 | 归档学科迁移策略 | ❌ 基本不成立 | `subject` 是字符串、直接渲染，不查表；`archivedAt` 确实存在，§9-19 已覆盖 |

**一句话**：这份审计的**高优先级清单里有一半是错的**（3、4 明确错误，1 建议有害），而**唯一真正致命的那条它只说对了一半**（第 2 条，它没意识到后果是数据丢失）。它的亮点恰恰在于第 2 条与第 9 条两个"时序类"问题——这类问题确实需要读源码才能发现，方向是对的。

---

## 1. 逐条裁定与证据

### ❌ 第 3 条：`createRecordBlock` 不存在 —— 错误

**它的断言**：「我用 codegraph_search 搜索 createRecordBlock 返回"No results found"…这个函数在当前代码库中不存在。」

**证据**：函数就在设计文档所说的位置。

```
src/hooks/useAppData.ts:816  const createRecordBlock = useCallback(
src/hooks/useAppData.ts:817    async (date = todayISO(), subject?: Subject, contentHtml = "<p></p>") => {
src/hooks/useAppData.ts:833      title: nextRecordTitle(normalizedSubject, subjectCount),
```

- 签名与设计 §5.1 写的「当前标题由 `nextRecordTitle` 自动生成」**完全一致**（:833）。
- 调用点也一致：`App.tsx:563 / :588 / :1362` 加上 `addRichTextBlock` 包装（`useAppData.ts:881`）。设计 §5.1 说「既有 4 个调用点」，数量对得上。
- 设计 §5.1 提出扩展为 `options?: { title?: string; planId?: EntityId }`，作为可选第 4 参不影响任何既有调用点。**设计是对的。**

**它为什么会错**：它的工具没有索引到这个仓库（`codegraph_search` 大概未建索引或索引了别的目录）。这是工具失败，不是设计缺陷。**它把工具的空结果当成了代码事实，并且没有用 `grep` 复核**——这是本次审计最值得引以为戒的方法论错误。

**顺带一个它没提、但对实现有用的发现**：`createRecordBlock` 在 :841-843 已经内建了「内容含决策块 → `addRecordToReview`」的逻辑。计划记录以 `contentHtml: ""` 创建，因此**不会**被误加入复习队列——设计与既有行为自洽（这一点设计 §5.1 只写了编辑器路径 :713-714，没写这条，实现时容易漏看，见 N-14）。

---

### ❌ 第 4 条：`dailyPlans` 索引串应包含 `deletedAt` —— 机制性错误

**它的断言**：「schema 字符串中包含了所有复合键的字段…这样 Dexie 才知道这个字段的存在，即使它不在索引中。」

**这是对 Dexie 工作机制的误解**：`stores()` 的字符串定义的是 **objectStore 与它的索引**，不是对象的字段白名单。IndexedDB 的 objectStore 是无模式的，写入对象上任何属性都会被原样存储，与是否建索引无关。

**仓库自身的反证（三条，任一条即可推翻它）**：

1. `reviewCoachSchema.ts:13` — `blocks: "id, date, type, order, updatedAt"`。而 `RecordBlock`（继承 `BaseEntity`，`types.ts:38` 有 `deletedAt?`）**确实**在用软删除：`deleteBlock` 写 `deletedAt`（`storageAdapter.ts:1592`），`purgeExpiredDeletedBlocks` 用 `.filter(block => Boolean(block.deletedAt))` 读它（:1652）。索引串里没有 `deletedAt`，功能完全正常。
2. `templates: "id, title, updatedAt, createdAt"`（:14）同理。
3. **它自己引用的"对比现有"例子自相矛盾**：它写 `recordReviews: "id, recordId, status, nextReviewDate, lastReviewDate, updatedAt, [status+nextReviewDate]"`，然后说 `dailyPlans` 应该"也包含 `deletedAt`"。但 `recordReviews` 的索引串里**根本没有** `deletedAt`——它拿一个反例来支持自己的结论。

**它对索引串语义的另一个误判**：`dailyPlans: "id, date, updatedAt, createdAt, linkedRecordId"` 里的 `id` 是**主键**而非索引，所以这个定义是 **4 个索引**（date / updatedAt / createdAt / linkedRecordId），不是 3 个。有意思的是它第 12 条又跟着设计 §10 说"新增 3 个索引"——**它把设计的笔误抄成了自己的前提**（见 N-7）。

**设计是否要改？** 不需要改。但它可以更精确：§2.4 的理由句「仓库既有表也未对 `deletedAt` 建索引」**是不准确的**——`decisionBlocks`(:50)、`decisionBlockArchives`(:51)、`decisionBlockFeedback`(:52) 等表**确实**对 `deletedAt` 建了索引。正确的表述是：「规模极小（10 年约 1 万行、单日个位数），内存过滤成本可忽略，因此不为此建索引」，而不是援引一个不成立的全称命题（见 N-6）。

---

### ✅ 第 2 条：回收器与 `flushDraft()` 竞态 —— 成立，且比它说的更严重

这是整份审计里**最有价值的一条**。我完整核实了时序，结论是：**设计里「判据含无草稿消除竞态」这句话逻辑反了**，后果是**用户输入被静默删除**。

**证据链**：

1. `RecordEditorPage.tsx:642-659` 的 `back()`：
   ```
   642  const back = () => {
   646    leavingRef.current = true;
   648    void (async () => {          // ← 不 await
   650      await stopRecordingIntoDraft();
   651      await flushDraft();
   654    })();
   658    onBack();                    // ← 同步立即执行
   659  };
   ```
   `onBack()` 在 `flushDraft()` 之前**同步**执行，注释 :653 明说「Returning must not depend on a recorder or storage operation completing」——这是**刻意设计**，不是疏忽。

2. 卸载清理也是不 await 的：`RecordEditorPage.tsx:461-468`，`void flushDraft()`。

3. `flushDraft` 内部（:269-311）：先走 `draftSaveQueueRef` 的 promise 链，再 `await onSaveDraft(...)`——一次真正的 IndexedDB 写。**没有同步完成的可能**。

4. 关键：`flushDraft` 在 :278 有一个前置守卫 `!hasDraftChanges(nextDraft, record)` → 直接 return。所以**没输入过就不写草稿行**；反之，**输入过的才写**。而"输入过"正是最需要保住的情况。

5. 致命的一环：`permanentlyDeleteBlock`（`storageAdapter.ts:1619-1644`）在同一个事务里执行 `db.recordDrafts.delete(blockId)`（:1631）。

**因此真实时序是**：

```
T1  用户打了字（尚未落草稿，或 350ms 防抖(:326)未到）→ 点返回
T2  onBack() 同步执行 → 导航状态变更 → 回收器触发
T3  回收器直读 Dexie：db.blocks.get → 仍是「空正文」（输入未保存）
                       db.recordDrafts.get → 还没有行
    → isEmpty = true → 物理删除记录
T4  flushDraft 才完成 → 写入 recordDrafts 行（记录已不存在）
    → 孤儿草稿行；或者写入被 T3 的 delete 覆盖掉
```

**结果**：用户「写了但没保存就返回」的内容**丢失**，而设计 §9 边界 5 明确承诺「草稿保留，显示未保存；不回收」。设计在这里给出了一个**反方向的保证**。

**对它的两个建议的评价**：

- 「在 `closeRecordInCurrentTab` 中必须 await `flushDraft()` 完成后再调用回收器」→ **不可行**。`closeRecordInCurrentTab === popCurrentTabDepth`（`App.tsx:497` 是一行别名），它拿不到编辑器内部的 flush promise；要 await 就必须把 flush promise 从 `RecordEditorPage` 提到 `App`，这正好违反 :653 注释确立的「返回不依赖存储」约定。**它没有意识到这条改动会撞上一条被注释固化下来的设计决策。**
- 「在回收器中增加一个短暂延迟（如 100ms）」→ **flaky 反模式**。IndexedDB 延迟无上界，100ms 是猜的；这类"睡一会儿"在 CI 与低端安卓机上都会间歇性失败，且失败的形态是数据丢失。

**我的建议（见 §3 修订清单 R-1）**：把"谁来做回收器触发者"改成**由完成 flush 的一方驱动**，并把"删除"这个不可逆动作**延后到第二次观察点**，用幂等的两段式取代时间竞猜。

---

### ✅ 第 5 条：「无决策块」冗余 —— 观察正确，但它的结论反了

**它的观察**：若 `recordToPlainText` 已经提取决策块，则"—.无决策块"永不单独触发。

**核实：成立。** `recordContent.ts:293-296`，`parseLinearRecordContent` 遇到 `record-decision-block` 会**递归展开内层**：

```
293  if (tag === "record-decision-block") {
294    nodes.push(...parseLinearRecordContent({ ...record, contentHtml: element.innerHTML }, assets));
295    continue;
296  }
```

所以含文字的决策块确实会被第一条覆盖，该条**确实冗余**。

**但它的建议（「删除这一条以简化逻辑」）方向反了——删掉才对，理由是它没想到的**：

保留这一条会在**"记录里只有一个空决策块"**时出问题：
- 空决策块 → 递归展开后无文本节点 → `recordToPlainText` 为空 → 第一条**满足**；
- 但 `extractDecisionBlocks(contentHtml).length > 0` → 「无决策块」**不满足** → `isEmpty = false`；
- 于是 `resolvePlanOutcome` 判为 `done` → **一条什么都读不到的记录拿到绿色对号**，而 §9 边界 4／用户需求 3 要求它必须回到未完成。

另外这个空决策块是可达的：编辑器保存时会因 `introducedDecisionBlocks` 把它加入复习（`RecordEditorPage.tsx:710-715`），所以它还会以"无内容的复习卡片"形式存在。

**结论**：删掉「无决策块」这一条。理由不是"简化",而是"它会把空记录误判为有内容"。真正保护复习记录的是 `recordReviews.status` 那一条，不需要靠它（详见 N-5 与修订 R-2）。

---

### ⚠️ 第 6 条：历史过滤与统计口径 —— 成立（澄清项）

**它的问题**：若某日 3 条计划全被软删除，算不算「有计划」？

**答案设计里已经隐含**：§4.1 的 `listDailyPlans` 明确「过滤软删除」，§7.3 要求「UI 与回收器读过滤视图」。视图层拿到的 `plans` 里本来就没有软删除行 → 该日 `total === 0` → 不是"有计划日期" → 不显示。

**所以这不是缺陷，是"读者要自己串起两节才能得出结论"**。它的建议（在 §3.3 补一句 `plans.filter(p => p.date === d && !p.deletedAt)`）是**合理的澄清**，但要注意：`buildDailyPlanViews` 接收的是**已过滤**的数组，不应对 `deletedAt` 再过滤一次（重复过滤会掩盖调用方忘过滤的 bug，违反 §7.3 的分层纪律）。正确写法是在 §3.3 写明「入参必须是 `listDailyPlans` 的输出（已排除软删除）」。

**它漏掉的真正相关口径问题**（见 N-9）：软删除一条未完成的计划会让完成率**悄悄上升**，这是派生统计的固有性质，但 UI 文案必须避免暗示"完成率"是客观事实。

---

### ❌ 第 7 条：`referenceDepth` 未定义 —— 基本错误

**它的断言**：「文档中没有解释 referenceDepth 是什么，它从哪里来」。

**证据**：它不是设计的产物，是**既有函数**，而且定义就在同文件：

```
src/lib/tabNavigation.ts:171  const referenceDepth = (state: RecordTabState): number => state.referenceStack?.length ?? 0;
src/lib/tabNavigation.ts:236  return memory.today.adaptiveTaskId ? 1 : memory.today.recordId ? 1 + referenceDepth(memory.today) : 0;
```

设计 §6.2 是在**改写第 236 行**，用的名字与既有代码一致，无需在文档里"解释"。**设计这一点是对的。**

**不过它误打误撞指到了一片真有问题的区域**——但真问题不在 `referenceDepth`，而在 §6.2 / §6.3 / §6.4 对这个既有状态机的处理。它一条都没看出来（见 N-1 / N-2 / N-4）。

---

### ❌ 第 8 条：同步实体类型命名不一致 —— 错误，且建议会引入新错误

**它的断言**：表名 `dailyPlans`（驼峰）与实体类型 `daily-plan`（短横线）不一致，需要补充映射规则说明，并建议写「如 recordReviews → record-review」。

**证据**：

1. `CloudSyncEntityType`（`types.ts:817-843`）**全部**是 kebab-case，且**从不**与表名同形：
   `"entry" | "block" | "template" | "draft" | "tag" | "study-session" | "settings" | "asset" | "review-state" | "review-day-stat" | "decision-block" | "adaptive-review-task" | …`
   → 设计的 `"daily-plan"` **完全符合既有约定**，不是特例。
2. **它给的例子是错的**：`recordReviews` 对应的实体类型是 `"review-state"`（`cloudSyncModel.ts:331`），不是 `record-review`。若照它的建议写进文档，会**在规格里植入一个错误映射**。
3. 映射关系本来就不需要"一句话概括"：它是 `cloudSyncModel.ts:322-470` 里逐条写死的 `mapEntities("…", payload.xxx)` 清单（:331 `"review-state"`、:332 `"review-day-stat"`、:396/:464 计数与还原）。设计 §7.2 已经把这个文件列成必改点，实现时照着清单加一行即可。

**结论**：第 8 条不成立；照它的建议改文档反而有害。

---

### ✅ 第 9 条：并发双击无防护 —— 成立（中）

**它的推理**：查询与写入之间不是原子的。

**核实：成立，而且比它的表述更具体。** 关键在于**导航发生在写完之后**，所以列表在整个 IndexedDB 往返期间一直可点：

- 设计 §6.7 自己写了时序：点计划条目 → `today.recordId = r1` → `createRecordBlock` + `linkPlanRecord` + `markCloudSyncMutation`。要拿到 `r1` 就必须先 `await createRecordBlock`，而它内部还串了 `listBlocks` + `getSettings` + `saveBlock` + `refresh` + `markAutoBackupDirty`（`useAppData.ts:818-845`）——**这是一个可感知的窗口**。
- 第二次点击进入时，`linkedRecordId` 尚未回填（或内存状态未刷新）→ 又建一条记录 → 同一计划两条日志，违反不变量 I1，而 I1 的"修复"是回收器清空 `linkedRecordId`（见 N-9 对此的批评）。

**对它的建议的评价**：它的"乐观锁"方向对，但落点不准——`linkPlanRecord` 里做 CAS 只能挡住**第二条 link**，挡不住**第二条记录已经被创建**（记录已经落库，需要额外的清理）。它的"UI 防抖 300ms"是猜时长。

**我的建议（R-3）**：在计划行上加**打开中的 in-flight 集合**（`Set<EntityId>`，页内 state），`openPlan` 进入时若命中则直接 return，完成后移除。确定性、无时长猜测、单行代码。

---

### ❌ 第 10 条：测试文件命名不一致 —— 错误

**它的断言**：「既有的是直接方法名（`storageAdapter.saveBlock.test.ts`、`storageAdapter.review.test.ts`）；新命名用了 `. 分隔`。」

**证据**：既有 13 个文件的命名**全都是** `storageAdapter.<方法或特性>.test.ts`：

```
storageAdapter.aiSettings.test.ts        storageAdapter.assetRefs.test.ts
storageAdapter.compact.test.ts           storageAdapter.duplicateTagCollision.test.ts
storageAdapter.initialize.test.ts        storageAdapter.patchAsset.test.ts
storageAdapter.recordTransferDecisionBlock.test.ts
storageAdapter.restore.test.ts           storageAdapter.review.test.ts
storageAdapter.saveBlock.test.ts         storageAdapter.saveEntry.test.ts
storageAdapter.saveStudySession.test.ts  storageAdapter.templates.test.ts
```

`sdd.saveBlock.test.ts` 与建议的 `storageAdapter.dailyPlan.test.ts` **结构完全同形**。它说的"既有用直接方法名、新的用点分隔"这个区别**不存在**，建议是空操作。**它把自己没看清的东西写成了不一致。**

**不过它促成了本节最有价值的一条发现**：真正需要改的测试文件**不是它（也不是设计）列的那些**（N-7）。

---

### ✅ 第 11 条：回收器返回值用途不明 —— 成立（低）

设计 §4.1 写 `Promise<EntityId[]>`「返回被回收的记录 id 列表（供日志/调试使用）」。它的质疑合理：要么真的 `console.debug`/写一条带 `[backup]` 那样前缀的诊断日志（仓库有先例：`recordContent.ts:167` 附近描述过 `[backup]` 前缀日志），要么改成 `Promise<void>`。

**建议采纳**：实现时**必须有具体消费者**，否则改 `Promise<void>`。单测可以用"回收后再查 `db.blocks.get(id)` 为空"来断言，不需要靠返回值。附带：设计的 §4.1 注释「供日志/调试使用」本身就是"用途待定"的自认，应当删掉。

---

### ⚠️ 第 12 条：性能缺索引大小估算 —— 前提有误

它说「新增 3 个索引」。**实际是 4 个**：`dailyPlans: "id, date, updatedAt, createdAt, linkedRecordId"` 中 `id` 是主键，其余 4 个是索引。设计 §10 自己写的是"3 个索引"——**设计笔误，它照抄了**（这是本次审计里唯一一次它对设计不假思索地跟随，恰好跟错了）。

**给它要的估算**（它没给，我补上）：1 万行 × 4 索引 × ~120B/键值 ≈ **< 5 MB**，相比 `blocks` 全量驻留内存（设计 §2.4 的前提）可忽略。所以估算的结论是"无关紧要"，而"把它写进文档"的价值约等于零。**这条可以不做**；真正该修正的是 §10 的 3 → 4（R-8）。

---

### ✅ 第 13 条：P5 验证步骤笼统 —— 成立（低）

成立，且改进成本很低。已在 §4 给出可照做的步骤（R-6）。它的三条步骤框架是对的，我按本仓库的真实路径补全了设备/账本/清表细节。

---

### ✅ 第 14 条：回滚「保留表定义无害」需验证 —— 成立且重要（但它猜错了答案）

**它问对了一个真问题**，可惜没找到机制。

**真实机制**：Dexie 打开数据库时会比对**声明版本**与**本地已存版本**。若本地是 24 而代码只声明到 23，Dexie 抛 `VersionError`，**应用连数据都打不开**。仓库**没有任何 `VersionError` 处理**（设计 §13 已把这一条列为高风险）——这正是为什么不能"把 `version(24)` 摘掉"。

**所以设计中「功能未上线前回滚 = 移除 `version(24)` 之外的 UI 与入口（保留表定义无害）」这句话是有歧义的**，必须拆成两种情形：

| 情形 | 允许的操作 |
| --- | --- |
| schema 24 **从未发布到任何设备**（含开发机以外的真机/桌面版/网页版用户） | 可以整体移除 `version(24)` 与 `dailyPlans` 表定义 |
| schema 24 **已发布到任一设备** | **绝不可**移除 `version(24)`；只能移除 UI 与入口。表与版本必须留着 |

**它问的"僵尸数据如何复用"**：答案是**不需要任何处理**——表还在、schema 版本还是 24、`DailyPlan` 行还是那些行，重新启用 UI 后直接读出来即可，不需要迁移、不需要"按 schema 版本判断"。**它猜的是"要写迁移逻辑"，实际上"什么都不写"才是对的**。

---

### ❌ 第 15 条：§14 两个细节应现在确认 —— 过时（且建议与用户决策冲突）

**它读的是更新前的文档。** 它引用「§14 的两个待确认细节」，但当前 §14 的标题已经是「**已确认细节（2026-09-16 用户拍板）**」，两条都已落地：

1. 标题落到 `RecordBlock.title`、正文留空 → **已确认**（它建议的正是这个，方向一致，只是它不知道用户已经拍板）。
2. 长度上限 → **已确认 40 字**（用户原话：「我一般的计划 title 不会写得过长。如果过长的话，我一般会分开，分成两个日志记录条目，也就是同一个学科下可能会有多个计划」）。

**而它建议「现在就确定：UI 限制 80 字」——与用户明确拍板的 40 字直接冲突。** 如果按它改，会把一个已经定稿的决策改回去。**这条必须驳回。**

**方法论提醒**：它显然是拿着"某个时间点的快照"在做审计，却没有核对自己读到的版本是否是最新一轮。审计产物应带版本指纹（我这份文档在文首声明了核对基线）。

---

### ❌ 第 16 条：归档学科迁移策略 —— 基本不成立

**它担心**：用户归档"高等数学"后，导出/导入/恢复旧备份，计划的 `subject` 还能正确显示吗？

**核实**：
- `Subject = string`（`types.ts:6`），`DailyPlan.subject: Subject` 就是一个**字符串**。列表渲染是直接显示这个字符串（设计 §8.2 线框「数学 · 三大计算…」），**不经过任何学科配置查表** → 没有"查不到"的失败路径。
- 它建议"确认 subjects 配置中是否有'已归档'字段"→ **有**：`SubjectConfig.archivedAt?: ISODateTime`（`types.ts:307`）。
- 设计 §9 边界 19 已覆盖它的担心：「历史计划仍显示原学科名；新建时下拉不含归档学科」。

**唯一成立的残余**：设计 §2.1 把 `subject` 标为「必填」，但没有说明"学科被硬删除"（而非归档）时怎么办。实际上仓库用的是 `archivedAt` 归档，学科不硬删（`SubjectPicker` 与 `saveSubjects` 都由配置驱动）。所以这是**非问题**，最多在 §2.1 加半句「`subject` 是自由字符串，反查不到配置时按原值显示，不进错误态」。

---

## 2. 它完全漏掉的问题（按严重度排序）

这一节是本次复核的主要产出。下面每一条我都给了源码位置，且**没有一条出现在它的 16 条里**。

### N-1 🔴 `getTabDepth("today")` 的改写会**无谓地改变既有分支优先级**（§6.2）

既有（`tabNavigation.ts:236`）：
```ts
return memory.today.adaptiveTaskId ? 1 : memory.today.recordId ? 1 + referenceDepth(memory.today) : 0;
```
设计（§6.2）：
```
recordId  ? (planOpen ? 2 : 1) + referenceDepth
          : planOpen ? 1
          : adaptiveTaskId ? 1
          : 0
```

**`adaptiveTaskId` 从"第一优先"变成了"最后优先"。** 虽然两者当前互斥（`openAdaptiveTask` 在设置 `adaptiveTaskId` 时显式清掉 `recordId`，`App.tsx:515`；且 `AdaptiveReviewPage` 没有任何打开记录的出口），所以今天不会分叉——**但这是一次没有收益的行为变更**，而且它与 `App.tsx:753-757` 的安卓返回键处理器**优先级相反**（那里 `adaptiveTaskId` 被放在 `getTabDepth` 之前拦截并走 `closeAdaptiveTask()`）。

**修法**：保持既有相对顺序，只**插入** `planOpen`：
```ts
adaptiveTaskId ? 1
: recordId ? (planOpen ? 2 : 1) + referenceDepth
: planOpen ? 1
: 0
```
这样安卓返回键的既有拦截顺序与 `popTabDepth` 仍然一致，设计 §6.3 里「安卓返回键不需要改动」的结论也才真正成立。

### N-2 🔴 `popTabDepth("today")` 漏掉了 `referenceStack` 与既有字段重置（§6.3）

设计 §6.3 的四步是「清 recordId → 清 planOpen → 清 adaptiveTaskId → 否则不动」。既有实现（`tabNavigation.ts:311-326`）**不是**这个形状：

```ts
case "today":
  if (memory.today.adaptiveTaskId) return {...};                    // ①
  { const previous = popRecordReference(memory.today);              // ② ← 设计完全没提
    if (previous) return previous; }
  return { ...memory, today: { ...memory.today,                     // ③
    recordId: undefined, highlightAssetId: undefined, recordEditing: undefined,
    referenceStack: [], restoreScrollY: undefined, adaptiveTaskId: undefined } };
```

两个必须修的点：

1. **`popRecordReference`（:207-231）必须优先于"清 recordId"。** 计划记录里的引用跳转（读取引用栈）是既有能力，`getTabDepth` 也用 `referenceDepth` 算了深度。若按设计的"有 recordId 就清 recordId"，从"计划记录 → 引用记录"再点返回会**直接弹回计划页**，栈被吞掉。正确顺序：`referenceStack 非空 → popRecordReference`（并保留 `planOpen`）→ 然后再清 `recordId`。
2. **重置字段不能只清 `recordId`。** 既有第③步同时清 `highlightAssetId` / `recordEditing` / `referenceStack` / `restoreScrollY`。设计只写"清 recordId"，实现时若照抄会**残留 `recordEditing`** → 下次从计划进入编辑器可能直接处于编辑态/沉浸态（`immersiveTaskActive` 会用 `recordEditing` 判 `App.tsx:1688`）。

**另外 `planView` 的重置没有定义**：用户从"历史"视图离开计划页，下次进来是"今日"还是"历史"？§6.7 只说页内切换写 `planView`，从没说何时清。建议：离开计划页时（清 `planOpen` 的那一步）一并 `planView = "today"`，让每次进入都从今日开始。

### N-3 🔴 `buildPlanIndex` 的键自相矛盾，且按 `recordId` 建键会漏查（§3.3 vs §8.6）

- §3.3 声明：`buildPlanIndex(plans: DailyPlan[]): Map<EntityId, DailyPlan>   // recordId → plan，用于编辑器归属展示`
- §8.6 使用：「数据来源：`planId` → 内存 `planIndex`」

**同一张 Map 被描述为两种键（recordId / planId）。** 这不是笔误级别的：两种键的语义差别决定了一个真实行为：

- 若按 `recordId` 建键 → 只有 `linkedRecordId` 有值的计划才进 Map。而归属标签的用途恰恰是「这条日志来自哪个计划」——若计划被删除（软删除 → `listDailyPlans` 过滤掉 → 不进 Map），标签只能退化显示 `[来自计划]`（§8.6 已接受）。**但还会漏掉另一种：`planId` 有效、记录尚未回填 `linkedRecordId` 的瞬间**（§4.3 规则 2 明确允许"先 saveBlock 再 linkPlanRecord"，存在"有记录、未关联"的中间态）→ 此时按 recordId 永远查不到。
- 若按 `planId`（即 `plan.id`）建键 → 与 §8.6 一致，与 §2.2「`planId` 只用于展示与归属查询」一致，也不受"未关联"中间态影响。

**修法**：`buildPlanIndex` 定义为 **`Map<DailyPlan.id, DailyPlan>`**，并修正 §3.3 的注释。顺带：编辑器要同时显示"计划标题"，所以只需要 plan 实体，不需要反查记录。

### N-4 🟠 `buildTabPageKey` 的改写会**丢掉每个教练任务的页面身份**（§6.4）

既有（`tabNavigation.ts:301`）：
```ts
return `${tab}-${depth}-${recordPart}-${memory.today.adaptiveTaskId ?? "dashboard"}`;
```
→ 令牌是**任务 ID 本身**，所以任务 A → 任务 B 的切换会被 `isSameVisualPage`（`App.tsx:241-246`）判定为**不同页面**，触发过渡动画。

设计 §6.4：
```
screen = planOpen ? "plan" : adaptiveTaskId ? "adaptive" : "dashboard"
```
→ 把任务 ID 换成了**字面量 `"adaptive"`**。任务 A → 任务 B 的 key 变成同一个 → 过渡动画不触发。

**修法**（保留既有语义，只加 `plan`）：
```
screen = planOpen ? "plan" : (adaptiveTaskId ?? "dashboard")
```
设计提出"必须把 screen 纳入 key"的**判断是对的**（`planOpen` 与 `adaptiveTaskId` 的 depth 都是 1，仅靠 depth 无法区分），只是落地时不要顺手抹掉既有令牌的信息量。

### N-5 🟠 §3.2 的「记录非空」与 §4.2 的 `isEmpty` 是两个不同的谓词，却没命名（§3.2 / §4.2）

§4.2 的 `isEmpty` 含 **7 个合取项**，其中 `recordReviews.status !== "active"` 与 `recordDrafts` 无行**不是内容判据**，而是"是否可安全回收"的判据。但 §3.2 的表格又用「记录非空」这一列去决定 `done` / `draft` / `pending`：

| 行 | 记录非空 | 有草稿 | outcome |
| --- | --- | --- | --- |
| 有记录 | 是 | – | `done` |
| 有记录 | 否 | 是 | `draft` |
| 有记录 | 否 | 否 | `pending`（等回收） |

若「记录非空」= `!isEmpty`（含草稿项），则"有草稿"那一列永远无法独立成立（`!isEmpty` 已经意味着"可能因草稿而非空"），表格自相矛盾。
若「记录非空」= 仅内容判据，那它与 §4.2 的 `isEmpty` **同名不同义**，实现时极易把两者混用。

**修法**：显式定义两个谓词，全文只用这两个名字：
```ts
hasReadableContent(record, ctx): boolean
//   = recordToPlainText 非空 ∨ assets>0 ∨ formulas>0 ∨ tags>0
//     （不含「无决策块」——见第 5 条裁定；不含草稿与复习状态）

canReclaimPlanRecord(record, ctx): boolean
//   = !hasReadableContent ∧ recordReviews.status !== "active" ∧ 无 recordDrafts 行
//     再加上 N-10 的「非本次返回窗口」条件
```
`resolvePlanOutcome` 用 `hasReadableContent` + 草稿；回收器只用 `canReclaimPlanRecord`。

### N-6 🟡 §2.4 的理由句与仓库事实不符（§2.4）

「仓库既有表也未对 `deletedAt` 建索引」是**全称命题，可直接被反例推翻**：`decisionBlocks: "id, recordId, contentVersion, updatedAt, deletedAt, [recordId+deletedAt]"`（`reviewCoachSchema.ts:50`），以及 :51 / :52 / :53 等表都索引了 `deletedAt`。设计的**结论（不建索引）没问题**，但理由应换成"规模极小 + 内存过滤"（§2.4 前半句已经有这个理由，后半句应删）。

### N-7 🟠 §7.2 的"测试枚举"必改点是**错的两个、漏的一个**

设计 §7.2 写：「测试枚举 `cloudSyncModel.test.ts:176`、`cloudSyncProtocol.test.ts:156` | 实体类型清单加 `"daily-plan"`」。

逐条核对：

1. `cloudSyncModel.test.ts:167-186` 的 `formalTypes` **被过滤后只用于 coach 断言**：
   `const formalTypeSet = new Set<CloudSyncEntityType>(formalTypes); exported.entities.filter(t => formalTypeSet.has(t))`
   → 加不加 `daily-plan` 都不影响该断言。**不需要改。**
2. `cloudSyncProtocol.test.ts:148-158` 断言 `coachTypes` = **10 个 coach 类型的精确集合**（`toEqual`）。它是 `deriveLocalCloudChanges(coached, ledgerFor(base))` 的**差集结果**，而 base/coached 的 `snapshot()`（:35-48）里没有计划数据 → 不会产生 `daily-plan` 实体。**不需要改。**
3. **真正会炸、设计没写的是** `storageAdapter.restore.test.ts:206-227` 的 `createRestoreDb()`：它**逐张**列出 MemoryTable（`blocks`、`recordDrafts`、`voiceRecallTurns`…），并以 `vi.doMock("../db/database", () => ({ db: fakeDb }))`（:369 等）**整体替换**真实 `db`。设计要在 `restoreStreamableSnapshot`（:2366 附近的 clear 清单）里加 `db.dailyPlans.clear()` → 该处 `db.dailyPlans` 是 `undefined` → `TypeError`。**必须同步加 `dailyPlans: new MemoryTable(),`。**
4. 同类但**编译期安全**的：`backup.test.ts:39-51`、`cloudSyncModel.test.ts:76-88`、`cloudSyncProtocol.test.ts:37-48` 的 payload fixture 逐字段列出 `BackupPayload`。因为 `dailyPlans?` 是可选字段，不改也能编过，但**这些 fixture 是"backup 往返含 dailyPlans"断言的载体**，P5 的 ZIP 往返测试要在这里加数据。

### N-8 🟠 §5.3 / §10 的回收成本模型严重低估（"O(计划数)，一次 blocks.get"）

设计写：代价 `O(计划数)`，仅对 `linkedRecordId` 有值的计划做一次 `blocks.get`。

**实际**：每个被回收的记录走一次 `permanentlyDeleteBlock`（`storageAdapter.ts:1619-1644`），它**每条**都做：
- 一个跨 ~15 张表（含 `reviewCoachFormalTables(db)`）的 `rw` 事务；
- `purgeReviewCoachFactsForRecord`；
- `cleanupOrphanAssetsForRecord(block, draft)`（会扫 `db.templates`、`knowledgePodcasts` 等）；
- **`new DexieReviewCoachRepository(db).rebuildProjections()`（:1642）——对全部决策块做一次全量重放**。

所以"点进 5 条计划都没写就返回"= **5 次决策块全量重放 + 5 次跨表事务**。§9 边界 3（同日 100 条计划）下最坏是 100 次。

**修法**：回收器**批量收集待回收 id，再统一执行**：把 `permanentlyDeleteBlock` 的循环包在一处，或新增一个内部批量入口（一次事务内 delete 多个 block，`rebuildProjections` 只在最后调用一次）。设计 §5.3 的成本描述与 §10 的性能行都要重写。

### N-9 🔴 不变量 I1 / I2 的"修复"是**破坏性**的，应当改为纯派生（§2.5 / §3.2）

§2.5 写：
- I1「一个计划最多关联一条未删除的记录 | 回收器修复：视为未完成并**清空 `linkedRecordId`**」
- I2「`linkedRecordId` 只指向未删除的记录 | 同上」

§3.2 表格：「有 / 记录已删 → `pending`（并标记待修复）」。

**问题**：`linkedRecordId` 指向的记录**软删除**（进回收站，`TrashPage` 可恢复）时，设计会**清掉关联**。于是用户「误删日志 → 从回收站恢复」之后，计划**永久**显示未完成，即使日志又回来了——**关联信息被不可逆地丢掉了**，而它本来是完好的。

这与设计自己的原则冲突：I3 的理由写的是「以记录为准，避免误改用户数据」。清空 `linkedRecordId` 就是一次"改用户数据"。

**修法**：`linkedRecordId` **不下发清空动作**，改为纯派生 + 点击时判定：
- `resolvePlanOutcome`：查 `recordsById.get(linkedRecordId)`，未命中或 `deletedAt` 有值 → `pending`。**这就是"自动显示未完成"**（§5.4 已经这么描述了，只是 §2.5/§3.2 又画蛇添足地加了清理动作）。
- 点计划条目时（§9 边界 20 的检查）改为：**命中且未删除 → 打开既有记录；否则 → 新建记录并覆盖 `linkedRecordId`**。这才是"双击防护"的正确落点（同时解决第 9 条）。
- 回收器只在**真正回收一条空记录**时清 `linkedRecordId`（此时记录被物理删除，不存在"恢复"的可能，清空是安全的）。

### N-10 🔴 给 `restoreStreamableSnapshot` 加清表会让"恢复旧备份"**清空所有计划**（§7.2）

设计 §7.2：「`storageAdapter.ts:2363` `restoreStreamableSnapshot` 的**显式清表清单** | 必须加 `db.dailyPlans.clear()`，否则恢复后残留旧计划」。

**这在"恢复新备份"时是对的，但在"恢复本功能上线前的旧备份"时会造成数据丢失**：旧快照的 `payload` 里**没有** `payload.dailyPlans` 字段 → 清空后 `bulkPut(snapshot.payload.dailyPlans ?? [])` 写入空数组 → **本机所有计划被抹掉**。

而且它会被**放大到云端**：`cloudSyncService.ts:2057-2059` 的**反向墓碑**会把"远端有、本地没有"的实体标成删除：

```ts
const tombstones = allRemote.entities
  .filter((entity) => !localKeys.has(entity.key) && !entity.deleted
    && entity.entityType !== "review-state" && entity.entityType !== "review-day-stat")
  .map((entity) => ({ ...entity, contentHash: `deleted:${entity.contentHash}`, payload: {}, deleted: true }));
```

`daily-plan` **不在**排除清单里 → 恢复一次旧备份再同步，**其他设备上的全部计划被删除**。这正是设计 §13 列为"既有极高风险"的路径，设计只写了一句"计划不新增该路径"——**它新增了**（只是形状与既有表相同）。

**修法（两条，必须都做）**：
1. 清表清单区分「字段缺失」与「空数组」：`payload.dailyPlans === undefined` → **跳过清空**（视为旧快照，保留本机计划）；`payload.dailyPlans` 是数组 → 按正常流程 clear + bulkPut。
2. 在 §7.2 显式写一行：`cloudSyncService.ts:2057-2059` **有意不加入** `daily-plan` 排除清单（与 `block`/`template` 同级）；并把这个文件与行号写进必改点清单，避免实现者"顺手加一个排除"或"完全没看这个文件"。

### N-11 🟡 §2.4 的"`blocks` 已在 `refresh()` 全量加载"表述不准确（结论仍成立）

`useAppData.refresh()`（:89-91）用的是 `storage.listBlocks()`，而 `listBlocks` **过滤 `deletedAt`**。真正全量的是 `createSnapshot` 里的 `db.blocks.toArray()`（§7.3 提到的那条）。所以"全量加载"应改为"已随 `refresh()` 载入内存（未删除部分）"。**不影响"不给 `blocks` 加 `planId` 索引"的结论**。

### N-12 ✅ 设计中「`createRecordBlock` 签名扩展影响既有调用点」评为低风险 —— **正确**

我核对了全部调用点：`App.tsx:563 / :588 / :1362` 与 `useAppData.ts:881`（`addRichTextBlock` 包装）、:901 / :908 / :915 / :927 / :934 / :993（示例/模板生成）。新增第 4 个可选参数不影响任何一个。**这一条设计判断正确。**

### N-13 ✅ 同步协议版本与 manifest 版本**不需要**变更 —— 设计判断正确，但应写明理由

设计 §7.1 写 `PROTOCOL_VERSION` 不变、§7.2 只加 `BackupManifest.counts.dailyPlans?`。核实：`BackupPayload.dailyPlans?` 为可选字段，`cloudSyncModel.test.ts:37` 的 `manifest.version: 6` 无需提升——旧版读取新快照会忽略未知字段，新版读取旧快照得到 `undefined` → `?? []`。**结论正确**；建议在 §7.1 补一句，否则将来有人会"顺手"把 version 提到 7 而触发不必要的兼容分支。

### N-14 🟡 §5.1 只写了编辑器路径的"自动加入复习"，漏了创建路径（§5.1）

§5.1 写「含决策块时沿用既有规则：新建日志自动加入复习（`RecordEditorPage.tsx:713-714`）」。实际上 `createRecordBlock` **自己**也做了这件事（`useAppData.ts:841-843`）。对计划记录而言这个漏项**后果为零**（`contentHtml: ""` → 无决策块 → 不加入），但它解释了一个实现期容易犯的错：若有人为了"让计划日志进复习"而改成预填正文，**会同时踩到两条自动加入路径**。建议 §5.1 一并写出，作为"不预填正文"的又一条理由。

---

## 3. 设计文档修订清单（可直接执行）

| 编号 | 位置 | 动作 | 来源 |
| --- | --- | --- | --- |
| R-1 | §4.2 / §5.3 | 重写竞态处理：① 回收触发改为**由完成 flush 的一方驱动**（`RecordEditorPage.back()` 的异步块在 `await flushDraft()` 之后再调 `onBack()` 之外的 settle 回调；UI 仍先导航，不违反 :653 注释）；② 无论如何，删除动作改为**两段式**——第一次观察只登记候选（记在内存或一个 `pendingReclaim` 设备本地表），**下一次观察点（计划页挂载/应用启动）仍是空的才真删**；③ 明令禁止"定时等待"式修法 | 第 2 条裁定 |
| R-2 | §3.2 / §4.2 | 按 N-5 拆出 `hasReadableContent` 与 `canReclaimPlanRecord`；**删除「无决策块」这一条** | 第 5 条裁定 + N-5 |
| R-3 | §9 边界 20 / §6.7 | 双击防护改为①计划行 in-flight `Set<EntityId>`；②点击时按 N-9 的"命中存活记录则打开，否则新建并覆盖" | 第 9 条 + N-9 |
| R-4 | §6.2 | **保持** `adaptiveTaskId` 第一优先，只插入 `planOpen`（见 N-1） | N-1 |
| R-5 | §6.3 | 补 `popRecordReference` 优先 + 完整的字段重置清单 + `planView` 离开时归位 | N-2 |
| R-6 | §6.4 | `screen = planOpen ? "plan" : (adaptiveTaskId ?? "dashboard")` | N-4 |
| R-7 | §3.3 / §8.6 | `buildPlanIndex` 统一为 `Map<DailyPlan.id, DailyPlan>` | N-3 |
| R-8 | §2.4 / §10 / §2.5 / §3.2 | ① 删掉"既有表也未对 deletedAt 建索引"；② 索引数 3→4；③ 成本模型改为批量；④ I1/I2 去掉"清空 linkedRecordId" | N-6 / 第 12 条 / N-8 / N-9 |
| R-9 | §7.2 | 必改点改为：删 `cloudSyncProtocol.test.ts:156`；加 `storageAdapter.restore.test.ts:206 createRestoreDb`（**会必然失败**）+ `backup.test.ts` / `cloudSyncModel.test.ts` fixture；加 `cloudSyncService.ts:2057` 并写明"有意不排除" | N-7 / N-10 |
| R-10 | §7.2 / §7.3 | 清表区分 `undefined` 与 `[]`；写明反向墓碑对本功能的影响与不复测不得上线 | N-10 |
| R-11 | §13 / §14 | 回滚策略拆成"是否已发布到任一设备"两情形，写明 Dexie `VersionError` 机制；§14 补一条"本轮已定稿的决策不接受再议" | 第 14 条裁定 / 第 15 条裁定 |
| R-12 | §11.1 | 补 `hasReadableContent` 的「只有空决策块」反例测试；补 `popTabDepth` 的 referenceStack 用例；补"打字后 1 秒内返回"的竞态回归测试 | R-1 / R-2 / R-5 |

---

## 4. P5 验证的具体步骤（替换 §12 的笼统描述）

**双设备同步**
1. 设备 A 建 3 条计划（含 1 条同一天同学科的第二条），并兑现其中 1 条（写入并保存日志）；记录同步前 A 的本地账本 revision `r0`。
2. 手动触发同步，等待完成；在 B 上确认：3 条计划齐全、兑现的那条显示绿色对号、日志正文完整。
3. 在 B 上兑现第 2 条 → 同步 → A 上看到 2/3 已完成。
4. 在 B 上**删除**第 3 条计划（软删除）→ 同步 → A 上该行消失，且**关联日志仍在**（不变量 I7）。
5. 在 B 上把第 1 条日志**移入回收站** → 同步 → A 上该计划回到未完成，**且 `linkedRecordId` 已按 N-9 的方案处理**（不清空或在点击时覆盖）。
6. **反向墓碑专项**：A 恢复一份**本功能上线前**的备份 → 同步 → 检查 B 的计划是否被清空（按 N-10 的修法应当**不被清空**；未修则必然清空，必须留档）。

**ZIP 往返**
1. 导出完整备份（`snapshotToZip`）→ 解压确认 `data.json` 含 `dailyPlans`、`manifest.json.counts.dailyPlans` 与之一致。
2. 清空数据库（`clearAll`）→ 导入 → 确认计划条数、`linkedRecordId` 指向、日志的 `planId` 全部还原。
3. **旧包兼容**：构造一份不含 `dailyPlans` 的旧 `data.json` → 导入 → 按 N-10 的修法应**保留本机计划**。

**文件夹备份 / 原生流**
1. 触发自动备份 → 确认流式写入的 `data.json` 含 `dailyPlans`。
2. 删除原文件 → 从备份恢复 → 校验步骤与 ZIP 第 2 步一致。
3. 校验 `restoreStreamableSnapshot` 的清表清单真的清了 `dailyPlans`（否则"恢复后残留旧计划"）。

---

## 5. 给"下一轮审计"的方法论（为何这份审计会错这么多）

1. **工具空结果 ≠ 代码不存在。** 第 3 条的根因是 `codegraph_search` 没索引到本仓库。凡是"X 不存在"类断言，必须用 `grep -rn` 在仓库根复核一次。本仓库的检索入口是文件系统，不是索引。
2. **不要用"直觉的框架约定"去替代理源码核实。** 第 4 条（Dexie 字段）、第 8 条（实体命名）、第 10 条（测试命名）都属于此类：它们都在讲"通常应该怎样"，而本仓库有明确的既有反例可查（`blocks` 的 `deletedAt`、`CloudSyncEntityType` 的 kebab-case、13 个既有测试文件名）。
3. **对自己引用的"反例"要先自检是否自洽。** 第 4 条引 `recordReviews` 的索引串来做论据，而那条串里没有 `deletedAt`。**引证自相矛盾是最高频的审计失误**。
4. **审计产物必须带版本指纹。** 第 15 条整条作废的原因是它读的是过期快照。审计文首应写明"核对基线：`<文件>` 第 `<commit/时间>` 版，核对时间 `<t>`"。
5. **时序类问题值得深挖到底。** 第 2 条与第 9 条是全篇最有价值的，因为只有它们去读了调用链的真实先后。审计的注意力应当**从"字段/命名一致性"转向"异步状态机的时序"**——前者靠猜，后者靠读。
6. **提建议前先检查建议是否撞上既有设计决策。** 它建议"await `flushDraft()`"，而 `RecordEditorPage.tsx:653` 的注释正是为禁止这件事而写的。**改一处代码之前先读它的注释**，这个仓库的注释密度很高，且几乎每条注释都在解释"为什么不是更显然的那种写法"。

---

## 6. 附：本次核对中被证实**正确**的设计判断（不要动）

审计的另一半价值是确认哪些地方**不需要改**。以下均经源码核对：

| 设计条目 | 核对结论 |
| --- | --- |
| §2.2「`planId` 为 `undefined` 时不进入稳定 JSON」 | ✅ `sortValue`（`cloudSyncModel.ts:121-137`）在 :130 显式跳过 `undefined`，既有记录哈希确实不变 |
| §4.2「必须走 `recordToPlainText`，禁止裸正则」 | ✅ :283-296 递归处理决策块；:332 起处理 `record-collapse`；裸正则必然误判图片/公式/折叠 |
| §5.1「`createRecordBlock` 签名扩展、4 个调用点」 | ✅ `useAppData.ts:816`，调用点数量与位置一致（N-12） |
| §6.5「`webNavigationHistory.ts:248` 的 today 分支」 | ✅ :248 就是该行；`optionalBoolean`（:53）存在；`restoreRecordState`（:182-198）**白名单**不含新字段，所以必须加在显式分支里——设计选对了位置 |
| §6.6「网页版返回行会自动出现」 | ✅ `App.tsx:1703-1711`：`depth>0 && !immersiveTaskActive && !currentRecord` → 计划页满足；补抑制条件的推理也正确（:1707 有 `adaptiveTaskId` 先例） |
| §6.6「`DailyPlanPage` 自带返回控件」 | ✅ 与 `AdaptiveReviewPage`（`onBack={closeAdaptiveTask}`）同类 |
| §6.3「`closeRecordInCurrentTab` 不需要改」 | ✅ `App.tsx:497` 是一行别名 `popCurrentTabDepth`，而 :476 直接委托 `popTabDepth`（但见 N-2：`popTabDepth` 内部必须改对） |
| §7.1「`"daily-plan"` 实体类型、不加入 `NON_CONFLICTING_ENTITY_TYPES`」 | ✅ 命名符合既有全体；`NON_CONFLICTING_ENTITY_TYPES`（`cloudSyncModel.ts:106`）只有 `review-state`/`review-day-stat`/`settings`/`template`，不含 `block` |
| §7.1「`PROTOCOL_VERSION` 不变」 | ✅ 可选字段无需提版本（N-13） |
| §7.2「`createCloudSyncSnapshot` 是 `createSnapshot` 的一行别名」 | ✅ `storageAdapter.ts:2139-2141` |
| §7.2 各文件行号 | ✅ 绝大多数准确（`createSnapshot:2070`、`createStreamableSnapshot:2143`、`clearAll:2396`、`exportCloudSync:322`、`materializeCloudSyncSnapshot:419`、`manifestFor:378`、`restoreStreamableSnapshot:2325` 内清表清单 ≈2366、`backup.ts:49/:200` 是 payload 构造处、`nativeAutoBackupStreamService.ts:58` 附近）。仅 `restoreSnapshotData` 标 :2219 实为 :2213 |
| §7.2「`firestore.rules` 无需改」 | ✅ 该文件按用户放开，不列实体 |
| §9 边界 19「归档学科」 | ✅ `SubjectConfig.archivedAt`（`types.ts:307`）；`subject` 是自由字符串、直接渲染 |
| §11.3「`npm run test -- --exclude "**/*.live.test.ts"`」 | ✅ 与仓库冻结文档的规范命令**逐字一致**（`docs/studyjournal-final-freeze-2026-09-15.md:41`、`docs/release-freeze-2026-09-09.md:27`）；`vitest.config.ts` 的 `include` 限定在 `src/**`，故该 flag 不会误扫 `node_modules` |
| §11.2「`e2e/daily-plan.spec.ts`」 | ✅ `playwright.config.ts` `testDir: "./e2e"`，默认 testMatch 命中 `.spec.ts` |
| §13「`createRecordBlock` 签名扩展为低风险」 | ✅ 见 N-12 |
| `TodayPage` 的入口"只需接线" | ✅ `TodayPage.tsx:25/:49/:83-84` 已有 `onOpenDailyPlan` 与按钮，`App.tsx` 从未传入 |

---

## 7. 最终裁定

- **对「外部 AI 审计报告」**：作为审计产物，**不通过**。16 条中 4 条是明确的事实错误（3/4/8/10），1 条整条过时且建议与用户决策冲突（15），3 条把既有代码当成缺陷（7/16 与 1 的建议部分）。**唯一不可略过的是第 2 条，但它只说对了一半**——真正的后果是用户输入被静默删除，而它给的两种修法一个会撞上既有设计决策、一个是 flaky 反模式。
- **对我自己的详细设计**：**方向与绝大多数工程细节成立**（§6 列了 16 条经核实的正确判断），但有 **4 个必须修的缺陷**（R-1 竞态与数据丢失、R-8④ 破坏性清关联、R-9/R-10 备份与同步的数据丢失放大路径、R-2 空记录误判完成）和 **6 个必须改对的细节**（R-4 / R-5 / R-6 / R-7 / R-8①②③ / R-9）。
- **建议的下一步**：按 §3 的 R-1…R-12 修订设计文档，**修订完成后再开始 P1 编码**。R-1 / R-8④ / R-10 三条必须在进入 P2（回收器）与 P5（同步备份）之前定稿，因为它们的失败形态是**不可逆的数据丢失**，无法靠事后测试补救。
