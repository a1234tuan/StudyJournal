# StudyJournal AI 上下文截断修复方案

- 制定日期：2026-09-14
- 决策固化日期：2026-09-14（A 类 4 项未定义行为已决策，见第 4 节）
- 审查基线：`b20aa7f224914ad9bfdd2dce6ba5da7f148f79cd`（`main`）
- 复现样本：`D:\DeskTop\study-journal-records-2026-09-14\records.json`（记录 `660DAY1`，数学，2026-08-27）
- 范围：语音复述的 LLM 上下文组装（主）、AI 问答的检索预算（次）、`recordToPlainText` 的公式重复倾倒（共因）
- 原则：只改上下文组装与文本抽取，不动数据库 schema、云同步契约、语音状态机；验收不调用真实付费供应商（延续 `docs/voice-recall-freeze-2026-09-11.md` 的冻结约定）

## 1. 总体结论

用户报告"语音复述时 AI 收到的内容不完整"**成立且严重**：样本记录纯文本 10060 字，实际只有 **1200 字（11.9%）** 进入提示词，19 个内容节点只有 3 个被发送，T3 之后 16 个节点（含 5 道题及全部解析）完全未发送。截断点与用户截图中 AI 自述的"停在 1 + 方块"逐字吻合。

三个根因，按影响排序：

1. **语音素材用写死的字符上限，而不是 token 预算。** `VOICE_TEACHER_MAX_RECORD_CHARACTERS = 1200`、`VOICE_TEACHER_MAX_MATERIAL_CHARACTERS = 6000` 是常量，对模型窗口大小完全无知。样本完整发送仅需约 6351 token，32k 窗口下还有约 16 倍余量。
2. **折叠块内的公式被重复倾倒，白吃掉预算。** `collapseElementText` 把块内**所有** `<record-inline-math>` 又裸露拼到文本末尾，而这些公式已经由 `stripHtml` 原位渲染成 `$…$` 出现在正文里。样本中 1932 字 / 674 token（占纯文本 19.2%）是纯冗余。
3. **截断既不按内容边界，也不告知模型和用户。** 现在切在公式中间；多选记录时第 6 条起被静默丢弃，界面只显示"（已截断）"，不说明丢了多少。

修复目标（可验收）：

| 目标 | 当前 | 修复后 |
|---|---|---|
| 样本单条记录语音发送 | 1200 / 10060 字（11.9%） | 8128 / 8128 字（100%，去重后） |
| 样本截断落点 | 切在公式中间，句子不完整 | 无截断；若必须截断则落在节点边界 |
| 截断声明 | 无 | 提示词内声明丢失范围，UI 显示实际发送量 |
| 多记录静默丢弃 | 第 6 条起完全丢失且无提示 | 公平分配 + 明确提示发送条数 |
| 32k 窗口下 5 条同规模记录 | 无法发送 | 实测约 28385 token，在 32544 可用额度内可全部发送 |

## 2. 基线实测事实（本次复现，未改动代码）

样本：`contentHtml` 24842 字 → `recordToPlainText()` **10060 字 / 约 6351 token**；19 个线性节点（13 text + 6 structure），含 T1/T3/T4/T5/T7/T10 六道题。

### 2.1 语音复述实际发送范围

| 节点 | 类型 | 字符区间 | 长度 | 结果 |
|---|---|---|---|---|
| 1–2 | text | 0–171 | 170 | 已发送（T1 题干） |
| 3 | structure | 172–1849 | 1677 | **内部被切断**，仅前 1028 字可见，丢 649 字 |
| 4–7 | text/structure | 1850–3755 | 1906 | 未发送（T3） |
| 8–10 | text/structure | 3756–5169 | 1413 | 未发送（T4） |
| 11–13 | text/structure | 5170–6595 | 1425 | 未发送（T5） |
| 14–16 | text/structure | 6596–8161 | 1566 | 未发送（T7） |
| 17–19 | text/structure | 8162–10042 | 1880 | 未发送（T10） |

第 1200 字的最后一段文本：`\frac{x^2 - f(x) + x}{x} = x - \frac{f(x)}{x} + 1 =`

### 2.2 体积对比

| 指标 | 数值 |
|---|---|
| 语音完整请求 | 1935 字 / 约 1921 token |
| 记录本身 | 10060 字 / 约 6351 token |
| 32k 窗口占用 | 约 6% |
| 模型窗口余量 | 约 16.7 倍 |

### 2.3 公式重复倾倒定量

| 指标 | 数值 |
|---|---|
| `<record-inline-math>` 元素 | 130（其中 120 个位于折叠/高亮块内） |
| `<record-formula>`（块公式）元素 | 38 |
| 折叠块内 inline-math 裸倾倒字符 | 1932 字（含换行） |
| 占纯文本比例 | 19.2% |
| 纯文本去重后 | 10060 → 8128 字；6351 → 约 5677 token（实测 `estimateAiTokens`） |
| 1200 字窗口的最后 260 字中，纯公式行占用 | 209 字（占窗口 17.4%） |
| 重复倾倒消耗的 token | 674 token（占记录总量 10.6%） |

### 2.4 AI 问答侧对照（同一样本，5 条同规模记录模拟）

| 场景 | 发送比例 | 整条丢失 |
|---|---|---|
| 1 条记录 | 100%（19/19 分片） | 无 |
| 5 条，聚焦检索 | 44.9% | 有（660DAY5 全丢，660DAY4 仅 2/19 分片） |
| 5 条，覆盖检索 | 71.4% | 无（每条约 17–18/19 分片） |

另：**32k 与 128k 窗口跑出结果完全一致** —— `retrievalTokens = min(常量, 剩余预算)`，常量（16000/24000）自身上限使模型窗口无法被利用。

## 3. 根因定位

### R1（P0）语音素材上限是字符常量，与模型窗口解耦

- `src/features/voiceRecall/teacherPrompt.ts:3-5`：`VOICE_TEACHER_MAX_MATERIAL_CHARACTERS = 6_000`、`VOICE_TEACHER_MAX_RECORD_CHARACTERS = 1_200`
- `teacherPrompt.ts:49`：`material.text.trim().slice(0, Math.min(1200, 6000 - used))`
- `src/features/voiceRecall/VoiceRecallWorkspace.tsx:643-648`：调用 `buildVoiceTeacherMessages` 时不传任何预算
- 对比：`src/services/aiClientService.ts:181-195` 已有一套正确的 token 预算算法（`contextWindowTokens - output - history - 预留`），语音链路完全没有复用它

### R2（P0）折叠块公式重复倾倒

- `src/lib/recordContent.ts:182-197` `collapseElementText`：`bodyText` 已由 `stripHtml` 把 `<record-inline-math>` 原位渲染成 `$…$`（见 `recordContent.ts:47-49`），却又在 `:188-190` 收集 `"record-formula, record-inline-math"` 追加到末尾
- 同源问题：`recordContent.ts:221-235` `highlightElementText` 完全相同的写法
- **删除倾倒会丢数据**：`stripHtml` 对 `<record-formula>`（块公式）没有规则，其内容目前**只**存在于这个倾倒列表里（38 个 / 2687 字），必须改为原位渲染而不是直接删除

### R3（P0）截断无边界、无声明、多记录静默丢弃

- `teacherPrompt.ts:47-53`：按 `material.text.trim().slice(...)` 硬切，无视节点边界（`parseLinearRecordContent` 已提供节点结构，可直接复用）
- `teacherPrompt.ts:55`：`inputTruncated` 只在标题后加"（已截断）"，不说明丢失范围，模型无法判断自己看到的不是全貌
- `teacherPrompt.ts:48`：`if (used >= maxMaterial) break;` —— 第 6 条起整条记录被丢弃，用户与模型均无感知

### R4（P2，旁证）AI 问答检索预算不随窗口伸缩

- `src/services/aiClientService.ts:184-195`：`retrievalTokens = min(retrievalTargetTokens, available)`，`retrievalTargetTokens` 固定为 16000/24000
- 结果：大窗口白买；同时 5 条规模下聚焦模式只发 44.9% 且整条丢失

## 4. 实施前固化的行为约定（A 类决策）

本节 4 项原先登记为"开放项"，现已决策，并作为 P0-1 / P0-3 的**前置约束**。第 5 节各 P0 项的"具体改动"已按本节改写，两处不再是并列关系。

### D1 语音素材预算 = `min(窗口可用额度, 窗口 × 70%)`

**决策**：v1 采用 **70% 窗口**作为素材上限，且**必须与"可用额度"取最小值**。

预算计算顺序（顺序不可交换）：

1. 先组装固定部分：安全护栏 + 语音人设 + 背景句 + 最近 10 轮 + 本轮发言；
2. `fixedTokens = estimateAiTokens(固定部分)`；
3. `outputReserve`：默认 `VOICE_LLM_DEFAULT_MAX_TOKENS (224)`；若 profile 声明 `voiceThinkingMode: "enabled"` 则取 `VOICE_LLM_MAX_TOKENS (250)` 并上浮 30% 作为推理预留；
4. `availableForMaterials = window - outputReserve - fixedTokens - VOICE_MATERIAL_SAFETY_RESERVE_TOKENS`；
5. **`materialBudget = min(availableForMaterials, floor(window × 0.7))`**。

**为什么必须是 `min`，而不能只取 70%**：只取 `window × 0.7` 在小窗口或长历史下会溢出。以 8k 窗口（8192）为例，固定部分（安全护栏 85 字 + 人设 499 字 + 10 轮历史约 1200 字）≈ 2500 token ≈ 窗口的 30.5%，叠加 70% 素材已达 100.5%，再加上输出预留 224 token 必然超窗口，会被供应商直接拒绝。取 `min` 可保证固定部分永远有位置。

**为什么 70% 是安全的**：`estimateAiTokens`（`src/services/aiContextService.ts:138`）本身是**故意高估**的（源码注释即写明 "deliberately conservative"）：纯中日韩文本按 1.65 token/字计，而主流 tokenizer 实际约 0.6–1.0 token/字；纯 latin 按 0.367 token/字计，实际约 0.25。因此真实余量远大于 ±15%，70% 是第二层保险。

**对样本的影响**：8128 字 ≈ 5677 token，远低于 `32k × 0.7 = 22937`，**100% 发送**。

**参数落点**：新增 `VOICE_MATERIAL_WINDOW_RATIO = 0.7`、`VOICE_MATERIAL_SAFETY_RESERVE_TOKENS = 512`，与既有常量集中放在 `teacherPrompt.ts` 顶部，便于后续单点调整。

### D2 安全性上限的行为：token 预算优先，字符上限由预算推导

> ⚠️ **本节推翻了上一轮"保留 6000 字兜底上限"的建议**，因为它会重新引入本次要修的 bug。

反例就是用户的这条记录：去重后纯文本 **8128 字 > 6000**。若兜底上限仍是 6000 字并且"超限即截断到上限"，那么即使 P0-1 的 token 预算算对了，这条记录**仍然会被截断到 6000 字**——用户报告的问题在最大窗口下依旧存在。

因此固化如下：

- **优先级：token 预算 > 字符上限。** 字符上限在任何情况下都不得低于 token 预算所允许的量，即不得成为功能上限。
- 字符上限改为**由预算推导**，不再是固定值：
  `hardCharCap = ceil(materialBudget / MIN_TOKENS_PER_CHAR)`，其中 `MIN_TOKENS_PER_CHAR = 0.367`（估算器对纯 latin 的理论下界 `(1/3) × 1.1`）。
  该推导使字符上限**在数学上不可能先于 token 预算触发**，它只拦截"估算器返回异常小值"这类失控，属于纯护栏。
- `VOICE_TEACHER_MAX_MATERIAL_CHARACTERS` / `VOICE_TEACHER_MAX_RECORD_CHARACTERS` 标记为 **deprecated**，不再作为功能约束；本次**不删除**（避免破坏既有导出与测试引用），仅在 JSDoc 中标注"退化为极端失控拦截，见 hardCharCap"。
- **超限时的行为（三选一定为"选项 B 的弱化版"）**：
  1. 按节点逆序裁掉素材尾部，直到满足 `hardCharCap` 或通过终检 → **请求仍然发出**，用户不会卡住；
  2. `console.warn` 输出结构化诊断（窗口 / 预算 / 实际用量 / 模型名 / 记录数 / 触发条件），便于事后定位预算算法 bug；
  3. 提示词内显式标记「素材因异常被截断，本次素材不完整」，让模型知道自己看到的不是全貌；
  4. **不**写数据库、**不**上报网络（沿用"诊断不含语音正文"边界）；面向用户的可见提示由 P1-2 的详情面板承担。
- **终检（权威护栏）**：组装完成后校验
  `estimateAiTokens(全部 messages) + outputReserve + VOICE_MATERIAL_SAFETY_RESERVE_TOKENS ≤ window`。
  不满足时同样走上述 1–3 步。字符上限是廉价前置检查，终检是兜底，两者都要实现。

### D3 余量回收：等分给"仍有未发送内容的记录"，不按长度加权

**三条规则全部固化**

- **回收触发条件**：等第一轮全部分配完再**统一回收**；不做"逐条即时回收"（即时回收会使结果依赖记录顺序，不可测）。
- **回收分配规则**：剩余预算**等分**给"仍有未发送内容的记录"，**不**按剩余内容长度加权。
- **终止与防死循环**：若某记录的**首个待发节点成本 > 它能分到的份额**，则该记录无法前进 → 标记为"未发送（份额不足）"并**从后续轮次排除**。这是必需的，否则该记录会在每轮继续领取份额却永远放不下任何节点，导致无限循环。

**边界情况（8 条等长记录、预算仅够 2.5 条）**：算法收敛结果是 **8 条各约 31.25%**——全部为部分发送，没有任何一条完整。

此处与上一轮预期（"前 2 条 100% + 中间 2 条 80% + 后 4 条 30%"）不同：后者是**加权或优先级**策略的结果，不是"等分 + 回收"的结果。**本方案采用等分**，理由是覆盖率最优且结果与记录顺序无关（可测、可复现）。

代价是所有记录都变成部分发送。对主场景（闭卷复述通常只选 1–3 条，样本量级下全部放得下）影响不大。若后续用户反馈"宁可少而完整"，只需启用常量 `VOICE_MATERIAL_ALLOCATION: "fair" | "sequential"` 切到顺序填充，**不需要改算法结构**——现在就把该常量位留出来，避免二次返工。

**实现契约**：独立纯函数，放在 `teacherPrompt.ts` 并导出，供单测与 UI 共用：

```
planVoiceMaterials(input: {
  materials: { title: string; nodes: LinearNode[] }[];
  materialBudgetTokens: number;
}): {
  blocks: { title: string; text: string; complete: boolean; tokens: number }[];
  stats: VoiceMaterialStats;   // 见 D4 与 P0-3
}
```

伪代码（`VOICE_MATERIAL_ALLOCATION === "fair"`）：

```
1. 归一化：每条记录拆成 LinearNode 列表，逐节点计算 token 成本（含"《标题》\n"与节点间换行的包装开销）
2. 预排除：若某记录的首个节点成本 > 0 且无法放入任何份额，标记 insufficient 并排除
3. 第一轮：share = materialBudgetTokens / 可分配记录数
   按 route.recordIds 顺序，逐节点贪心累加，直到"再加一个节点就超过 share"为止，记录每条实际用量
4. 回收轮：surplus = materialBudgetTokens - Σ已用
   若 surplus ≥ 剩余记录中最便宜的"下一节点成本"：
     share = surplus / 仍有未发送内容的记录数，回到步骤 3
   否则结束
5. 若某一轮没有任何记录前进（全部因份额不足被排除）→ 结束（防止死循环）
6. 输出 blocks 与 stats；写入提示词的文本按节点顺序拼接，保证截断落在节点边界
```

**必测用例**：等长 8 条 × 预算 2.5 条 → 各约 31.25%；1 条超长记录 → 完整发送；某记录单节点超预算 → 标记 insufficient 且不死循环；空预算 → 全部未发送且不抛异常。

### D4 截断元信息：v1 不持久化，改为"派生值按需计算"

**事实核对（这是选择"派生"而非"存储"的依据）**

- `voiceRecallRuntime` 是模块级单例（`src/features/voiceRecall/runtimeController.ts:394`），工作区默认直接使用它（`src/App.tsx:1527` 未传 `runtime` prop），因此它天然跨导航与卸载存活。但该类是语音状态机，往里塞展示用字段会牵动状态机测试，不划算。
- 关键观察：**分配结果本来就是每轮重新计算的**（`VoiceRecallWorkspace.tsx:643` 每轮调用 `buildVoiceTeacherMessages`），素材集合来自 `route.recordIds`、预算来自当前 LLM profile —— 两者在渲染时都能直接拿到。

**决策**

- `materialStats` **不写入任何 Store**：不新增 `voiceRecallSessions` 字段，**零 schema 改动**，符合 `docs/voice-recall-freeze-2026-09-11.md` 的冻结承诺。
- 详情面板打开时**实时调用 `planVoiceMaterials(...)` 计算并展示**，与真正发送时使用**同一个纯函数**，因此显示值不会与实测值漂移。这也优于"组件内 useState 暂存"：state 方案会随卸载丢失，且暂存值可能与实际发送量不一致。
- UI 文案需写明口径："按当前素材与模型配置计算，本轮将发送 X / Y 字"，并标注**仅当次通话有效**。切换 LLM 供应商或改动素材选择后该数字随之变化——这是正确行为，因为下一轮预算确实会变。
- 若后续需要"在历史记录里回看当时发送了多少"，属于 schema 变更（Dexie 版本升级 + migration + 云同步/备份边界测试），**另立计划**，不塞进本次。
- 保持既有边界：stats 只含计数与 token 量，**不含素材正文**，符合"诊断信息不含语音正文或密钥"。

## 5. 修复方案

### P0-1 语音素材改为 token 预算（替代 1200 字硬上限）

**改动文件**

- 新增 `src/lib/aiTokens.ts`：把 `estimateAiTokens` 从 `src/services/aiContextService.ts:139` 迁出（`aiContextService` 保留 re-export，避免 `aiClientService`、`analysisPlanner`、`AiKnowledgeScopePicker` 三个调用点改动）。理由：`teacherPrompt.ts` 不应依赖 `aiContextService`（后者会带入 `decisionBlockContent`、`ocrDiagnostics` 等重依赖）。
- `src/features/voiceRecall/teacherPrompt.ts`
- `src/features/voiceRecall/VoiceRecallWorkspace.tsx`

**具体改动**

1. `buildVoiceTeacherMessages` 新增可选入参 `materialTokenBudget?: number`；未传入时（如旧调用点、测试）回退到"按 D1 公式用缺省窗口推导"，保持向后兼容。
2. 预算计算严格按 **D1** 的五步执行：先组装固定部分并估算 `fixedTokens`，再算 `availableForMaterials`，最后取 `materialBudget = min(availableForMaterials, floor(window × 0.7))`。`fixedTokens` 必须先算，否则 D1 中"历史 10 轮被素材挤压"的情形无法防止。
3. 素材分配调用 **D3** 的 `planVoiceMaterials(...)` 纯函数（第一轮等分 → 统一回收轮 → 未前进即终止），严格按节点边界分配；不在此处重复实现分配逻辑。
4. 安全性上限按 **D2** 处理：`hardCharCap` 由 `materialBudget` 推导（不是固定 6000 字），超限时"裁尾 + `console.warn` + 提示词标记"，并追加组装后终检。`VOICE_TEACHER_MAX_*_CHARACTERS` 标记 deprecated、保留不删。
   - 注意：**不得**把固定 6000 字当作功能上限——样本记录去重后为 8128 字，固定 6000 会导致本轮修复对该记录失效。
5. `VoiceRecallWorkspace.tsx` 解析当前 LLM profile（`llmProfiles` 中 `activeProviderConfig.llmProfileId` 对应项）的 `contextWindowTokens`，缺省回退 `DEFAULT_AI_CONTEXT_WINDOW_TOKENS`（`src/lib/aiProviders.ts:5`，65536），按 D1 公式得出 `materialTokenBudget` 传入；同一 profile 对象也供 **D4** 的详情面板派生计算复用。

**验收标准**

- 样本记录单条语音复述：素材完整发送（去重后 8128 字 / 约 5677 token），截断标记为"无"。
- 5 条同规模记录（各约 8128 字 / 5677 token）在 65536 窗口下全部发送；在 32768 窗口下不超预算（实测 5 条合计约 28385 token，加固定开销后仍在 32544 可用额度内）。
- 单测断言：给定窗口与记录数，实际组装的 messages 总 token 估算 ≤ 预算。

**风险**

- 预算算错会导致请求超窗口被供应商拒绝 → 用兜底字符上限 + 单测双重约束。
- 上下文变长后 LLM 首字延迟可能上升 → 属于预期权衡，可后续加"素材摘要优先"策略。

### P0-2 消除公式重复倾倒

**改动文件**：`src/lib/recordContent.ts`

**具体改动**

1. `stripHtml` 增加块公式规则：`<record-formula data-latex="X" data-title="T">` → 原位渲染为 `$$X$$`（title 非空时前置一行标题），使块公式回到它在正文中的真实位置。
2. `collapseElementText`（`:182-197`）删除 `...formulas` 这一项 —— inline-math 已在 `bodyText` 中原位出现，块公式已由第 1 步原位渲染。
3. `highlightElementText`（`:221-235`）同样删除 `...formulas`。
4. `collapseElementMarkdown`（`:199-208`）跟着受益，无需额外改动（它复用 `collapseElementText` 并过滤 title/summary 行）。
5. 保留 `...assets`（资源标题 + OCR 文本目前**只**来自于此，没有原位渲染来源），不在本次范围。
6. 顺带审计 `src/lib/recordStructureBlocks.ts` 的 `structureBlockPlainTextFromElement` 是否存在同款倾倒（样本记录不含结构图块，本次未验证）——发现同款问题则一并修，否则记为遗留项。

**验收标准**

- 样本记录 `recordToPlainText()` 长度从 10060 字降至 8128 字（节省 19.2%），且公式位置与其在正文中的位置一致。
- 断言块公式内容**仍然存在**（防止误删，38 个块公式 2687 字不得丢失）。
- 断言同一 `data-latex` 值在输出中不再出现两次。

**风险（重要）**

`recordToPlainText` / `recordToLinearMarkdown` 有 4 类下游消费者，需逐个回归：
`src/components/RecordCard.tsx:40`（卡片摘要）、`src/lib/search.ts:66`（搜索索引）、`src/services/knowledgeExportService.ts:51`（知识导出正文）、`VoiceRecallWorkspace.tsx:646`（语音素材）。
其中**知识导出的 markdown 格式会变化**（块公式从尾部倾倒变为原位），属于改进，但会改变导出文件内容，需你确认可接受。

### P0-3 截断按节点边界 + 显式声明丢失范围

**改动文件**：`src/features/voiceRecall/teacherPrompt.ts`（配合 `parseLinearRecordContent`）

**具体改动**

1. 素材截断改为逐 `LinearNode` 累加：放得下整节点就放，放不下就停，**不切在节点中间**；该逻辑归 **D3** 的 `planVoiceMaterials` 统一实现。
2. 截断元信息由 **D3** 的 `planVoiceMaterials` 返回值 `stats` 承载，结构固化如下（`VoiceMaterialStats`）：

```
VoiceMaterialStats = {
  sentRecords: number;        // 实际发送的记录数
  totalRecords: number;       // 本次选中的记录数
  sentChars: number;          // 实际发送字符数
  totalChars: number;         // 素材总字符数
  sentTokens: number;         // 实际占用 token（实测估算器）
  materialBudgetTokens: number; // 本次预算（见 D1）
  truncated: boolean;
  reasons: ("budget" | "safety-cap" | "insufficient-share")[]; // 触发截断的原因
  droppedRecords: number;     // reasons 含 insufficient-share 时被整条排除的记录数
}
```

3. 存储位置按 **D4** 决策：**不持久化**，由 `planVoiceMaterials` 在渲染时按需计算，`buildVoiceTeacherMessages` 与详情面板共用同一函数与同一份 stats，因此显示值与发送值不会漂移。**不新增 Dexie 字段、不写 `voiceRecallSessions`。**
4. 提示词内声明，例如：
   `【日志内容（本次发送 3/6 条，共 4200/10060 字；未发送部分未提供，不要假设已看全）】`
   明确告诉模型"你看到的不完整"，避免它把局部当全貌下结论（正是用户截图第 4 轮的成因）。当 `reasons` 含 `safety-cap` 时，声明改为「素材因异常被截断，本次素材不完整」（见 D2）。

**验收标准**

- 截断位置恒为节点边界（断言输出不以半个公式/半句话结尾）。
- 存在截断时提示词内必含丢失范围声明，且 `reasons` 正确区分 `budget` / `safety-cap`；无截断时不出现该声明（避免噪声）。
- 断言 `stats` 未写入任何 Store（可在回归中检查 `voiceRecallSessions` 写入字段集合未变化）。

### P1-1 多记录公平分配与条数提示

**改动文件**：`teacherPrompt.ts`（算法见 **D3**）、`VoiceRecallWorkspace.tsx`（展示）

**具体改动**：多选记录时不再"先到先得"，改为 **D3** 的等分份额 + 统一回收轮；`VOICE_MATERIAL_ALLOCATION` 常量位一并落地（v1 取 `"fair"`），UI 上明确显示"已发送 X / Y 条"。

**验收标准**：8 条各 2000 字的等长记录在"预算仅够 2.5 条"的场景下，不再出现"第 6 条起为 0 字"的静默丢弃，而是 8 条各获得约 31.25%（与 D3 边界情况一致）；`droppedRecords` 为 0；结果与 `route.recordIds` 顺序无关（打乱顺序结果相同）。

### P1-2 通话详情显示素材实际发送量

**改动文件**：`src/features/voiceRecall/VoiceRecallWorkspace.tsx:1181`（详情抽屉「资料」行）

**具体改动**：`资料` 行由"3 条日志"扩展为"3 条日志 · 本轮发送 4200 / 10060 字"；数据来源按 **D4**，在面板打开时调用 `planVoiceMaterials(...)` 派生计算，**不读 Store、不做持久化**；被截断时附加提示，触发 `safety-cap` 时给出更醒目的异常提示。

**验收标准**：不新增数据库字段、不进摘要、不写 `voiceRecallLocalHistory`，纯前端派生展示，符合"诊断信息不含语音正文"的既有边界；文案注明"仅当次通话有效"。

### P2-1 检索预算随模型窗口伸缩（AI 问答）

**改动文件**：`src/services/aiClientService.ts:184-195`

**具体改动**：`retrievalTargetTokens` 由固定 16000/24000 改为 `min(窗口可用额度, 上限常量)`，让大窗口真正生效；同时不放松 `MAX_AI_RETRIEVAL_TOKENS` 上限。

**验收标准**：128k 窗口下 5 条同规模记录的发送比例由 44.9% 提升，且不再整条丢失记录。

**说明**：本项独立于语音链路，可单独排期，不影响 P0。

### P2-2 结构图块同源审计

**改动文件**：`src/lib/recordStructureBlocks.ts`（仅审计，视结果决定是否修）

## 6. 明确不改的部分（边界）

- 不改数据库 schema、不新增 Dexie Store、不改云同步/备份/ZIP/知识导出契约与 `markCloudSyncMutation` 记账
- 不改 `RecordBlock.contentHtml` 与编辑器文档语义（只改"读取时的纯文本投影"）
- 不改语音状态机、ASR/TTS 链路、`NativeVoiceCapture`、半双工策略
- 不改 `voiceRecallSessions/Turns/LocalHistory` 三个 device-local Store 的语义
- 不为验收调用真实付费供应商

## 7. 验证计划

**单测（`npm test`，不联网）**

- `src/features/voiceRecall/teacherPrompt.test.ts`：需更新既有断言（`:48` 现在直接用 `VOICE_TEACHER_MAX_MATERIAL_CHARACTERS + 60` 作为上界，需改为按预算断言）。新增用例：
  - `planVoiceMaterials` 的 D3 四条必测用例（等长 8 条 × 预算 2.5 条 → 各约 31.25%；单条超长记录完整发送；单节点超预算记录被标记 `insufficient-share` 且不死循环；空预算不抛异常）；
  - D1：预算 = `min(可用额度, 窗口 × 0.7)`，且小窗口（8k）下固定部分仍能放下；
  - D2：`hardCharCap` 由预算推导（断言"固定 6000 字不构成功能上限"：8128 字的样本记录不被截断）；`reasons` 正确区分 `budget` 与 `safety-cap`；
  - 组装后终检：messages 总 token 估算 + 输出预留 + 安全余量 ≤ 窗口。
- `src/lib/recordContent.test.ts`：新增"公式不重复""块公式仍存在""折叠块输出长度下降"三类用例。
- `src/services/aiContextService.test.ts`：确认 `estimateAiTokens` 迁移后 re-export 不破。
- `src/features/voiceRecall/productionPipeline.test.ts`、`runtimeController.test.ts`：确认未受影响的回归。

**回归**

- `RecordCard` 摘要、`search.ts` 索引、知识导出 markdown 三处下游快照/行为核对。
- `e2e/voice-recall-policy.spec.ts` 需核对是否存在对素材上限的隐含依赖。
- D4 边界回归：断言 `voiceRecallSessions` 的写入字段集合未因本次改动而变化（证明零 schema 改动）。

**手工验证（样本驱动）**

- 用 `records.json` 同一记录走一遍语音复述开始页，核对详情面板显示的发送字数、以及首轮 AI 回复是否能看到后续题目。

## 8. 待确认事项（原"开放项"已收敛）

A 类 4 项（D1 预算取值、D2 安全上限行为、D3 余量回收规则、D4 元信息存储）**均已决策并写入第 4 节与第 5 节正文**，不再列为待确认。剩余 3 项：

1. **知识导出格式变化**：P0-2 会让导出的 markdown 中块公式回到原位（现状是集中在折叠块尾部）。是否接受？
2. **P2-1 是否一并做**：AI 问答的检索预算随窗口伸缩是独立改进项，可本次一起做，也可等 P0 验收通过后再排。
3. **P2-2 是否纳入**：结构图块倾倒仅为审计项，样本数据无法验证。

## 9. 建议执行顺序

前置：第 4 节 D1–D4 已固化，P0-1 / P0-3 / P1-2 的实现不得偏离该节。

1. P0-2（`recordContent.ts` 去重）—— 独立、可单测、立即释放 19.2% 预算
2. P0-1 + P0-3 + P1-1（`teacherPrompt.ts`：按 D1 预算公式、D3 分配算法一次性重构，避免两次改同一函数）
3. P1-2（UI 派生展示，按 D4 不落库）
4. P0 全量单测 + 手工验证样本
5. （可选）P2-1、P2-2

## 10. 实施结果（2026-09-14 完成）

P0-2 / P0-1 / P0-3 / P1-1 / P1-2 已按第 9 节顺序实施完毕。P2-1、P2-2 未做（第 8 节第 2、3 项仍待确认）。

### 10.1 改动文件

| 文件 | 改动 |
|---|---|
| `src/lib/aiTokens.ts` | **新增**。`estimateAiTokens` 迁至此，导出 `AI_MIN_TOKENS_PER_CHAR` 等常量 |
| `src/lib/aiTokens.test.ts` | **新增**。含"按最小费率推导的字符上限是安全"与单调性断言 |
| `src/lib/recordContent.ts` | `stripHtml` 增加块公式原位规则；删除两处公式倾倒；**新增 `recordToPlainTextNodes`** |
| `src/lib/recordContent.test.ts` | 新增公式原位/不重复用例 |
| `src/features/voiceRecall/contentBoundary.ts` | **新增**。抽出 `UNTRUSTED_LEARNING_CONTENT_GUARD`，使提示词层无需依赖网络适配器 |
| `src/features/voiceRecall/teacherPrompt.ts` | 预算 + D3 分配 + 提示词声明重构 |
| `src/features/voiceRecall/contracts.ts` | `contentBoundary` 改用共享类型 |
| `src/features/voiceRecall/openAiLlmStreamAdapter.ts` | 护栏常量改为 re-export |
| `src/features/voiceRecall/VoiceRecallWorkspace.tsx` | 解析 profile 窗口、按轮计算、详情面板派生展示 |
| `src/services/aiContextService.ts` | `estimateAiTokens` 改为 re-export（`aiClientService`、`analysisPlanner`、`AiKnowledgeScopePicker` 零改动） |

### 10.2 实测结果（对比第 1 节目标）

| 指标 | 修复前 | 计划目标 | **实测** |
|---|---|---|---|
| 样本纯文本长度 | 10060 字 | 8128 字 | **8210 字**（−18.4%） |
| 样本 token（估算器） | 6351 | 约 5677 | **5672** |
| 语音实际发送 | 1200 / 10060 字（11.9%） | 100% | **8210 / 8210 字（100%）** |
| 发送节点数 | 3 / 19 | 19 / 19 | **19 / 19** |
| 完整请求 token | 约 1921 | — | **7263 / 65536（11.1%）** |
| 截断落点 | 公式中间（`1 + 方块` 后） | 节点边界 | **节点边界（紧窗口下收在 T7 题干句末 `。`）** |
| 截断声明 | 仅"（已截断）" | 声明丢失范围 | **`本次发送 1/1 条，共 5611/8210 字；未发送部分未提供，不要假设已看全`** |
| 多记录公平分配 | 第 6 条起静默丢弃 | 等分 + 回收 | **实测 8 条各 31.0%（单节点记录），插叙式记录按整节点保留** |

验证：`npm test` **1011 passed / 2 skipped**（skipped 为既有 live 供应商用例，按冻结约定排除）；`tsc -b` 零错误；`vite build` 成功。

### 10.3 与计划的偏离（5 处，均需知悉）

**偏离 1：块公式渲染为 `title\nlatex`，而非计划写的 `$$X$$`（P0-2 步骤 1）**

计划第 5 节写的是原位渲染为 `$$X$$`。实现改为 `[title, latex].join("\n")`，与顶层 `recordToPlainText` 的公式节点投影**逐字一致**。

原因：`stripHtml` 同时服务纯文本与 markdown 两条路径（`inlineMarkdownText` = `decodeHtml(stripHtml(...))`）。若折叠块内用 `$$` 而顶层节点不用，同一份纯文本里会出现两种公式写法，反而制造新的不一致。位置正确性（本次修复的真正目标）两者等价。

**影响**：知识导出的 markdown 中，折叠块内的块公式由"集中在尾部、无定界符"变为"原位、无定界符"；顶层块公式仍是 `### 标题` + `$$` 形式。即第 8 节第 1 项的格式变化**已发生**，且比计划描述更保守（未新增定界符）。

**偏离 2：`planVoiceMaterials` 的素材单位是纯文本片段，不是 `LinearNode[]`（D3 契约）**

计划 D3 的签名是 `materials: { title: string; nodes: LinearNode[] }[]`。实现为 `nodes?: readonly string[]`（`recordToPlainTextNodes` 的产物）。

原因：`teacherPrompt` 不应依赖 `recordContent` 的节点模型（会引入 `recordStructureBlocks` 等依赖）；而预算的真实单位本来就是每节点的纯文本长度。为此新增 `recordToPlainTextNodes`，并把 `recordToPlainText` 改为 `nodes.join("\n\n")` —— 已有测试断言两者严格等价。

**偏离 3：超大记录"首个片段放不下"时改为切分，而不是整条排除（D3 终止规则）**

计划 D3 写："若某记录的首个待发节点成本 > 它能分到的份额 → 标记为 insufficient 并排除"。

实现改为：**切分该片段**（优先行边界，其次字符），只有 `share < VOICE_MATERIAL_MIN_RECORD_TOKENS (48)` 时才排除。

三条理由：

1. 计划给出的排除理由是**防死循环**。实现的回收循环在**记录级**推进，`pending` 每轮严格减小，本身就必然终止，不需要该规则兜底。
2. 排除会**白扔份额**。若一条记录只有一个长节点（例如整段解析），排除它等于把分给它的预算完全浪费。
3. 若采用排除，D3 的必测用例（8 条等长记录 × 2.5 预算 → 各约 31.25%）在"每条只有一个长节点"时**会失败**（全部被排除，各 0%），与计划自身的预期冲突。

`insufficient-share` 仍在使用，只是触发条件收敛为"份额低于可用阈值"。

**偏离 4：`reasonCodes` 与 `reasons` 并存；`droppedRecords` 为对象数组**

计划 P0-3 要求 `reasons: ("budget" | "safety-cap" | "insufficient-share")[]` 且 `droppedRecords: number`。实现同时提供机读的 `reasonCodes` 与面向用户的 `reasons: string[]`，`droppedRecords` 为 `{index,title,reason}[]`（便于 UI 点名被跳过的记录）。

**附带偏离（5）：`outputReserve` 直接取 `clampVoiceLlmMaxTokens(profile.maxTokens)`**

计划 D1 步骤 3 写"默认 224；`voiceThinkingMode: "enabled"` 时取 250 并上浮 30%"。实现改为直接复用 `productionPipeline` 的钳制函数（≤250）。

原因：该函数的结果就是适配器真正发给供应商的 `max_tokens`（`productionPipeline.ts:143` → `openAiLlmStreamAdapter.ts:50`），因此预留与实际请求**精确对齐**；且开启 thinking 时推理 token 是从同一个 `max_tokens` 里扣的，不是额外增加，上浮 30% 反而会过度预留。

### 10.4 仍未闭合

- 第 8 节 3 项待确认事项**未变更**：知识导出 markdown 格式变化（已发生，见偏离 1）、P2-1、P2-2。
- 手工验证（第 7 节"样本驱动"）需在真机/真实账号下走一遍才能勾掉；自动验收不含真实供应商调用。
- `hardCharacterCap` 的兜底 `console.warn` 在正常路径**永不触发**（数学上不可能先于 token 预算），因此无对应"必定触发"的自动化用例，仅以不变量断言覆盖（`sentChars ≤ materialCharacterCap`）。

