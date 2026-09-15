# AI 驾驶舱修复方案（学习效果优先）

> **状态更新（2026-09-15）**：本文是实施前方案，P0-P4 已在 `da8b566` 完成并通过本地自动化验收。付费 Provider 验收仍未执行；完成范围、偏差与验证结果见 `docs/ai-cockpit-remediation-acceptance-2026-09-14.md`。以下正文保留为决策记录，不再表示“本轮未修改源码”的当前仓库状态。

> 制定日期：2026-09-14
> 输入依据：`docs/audit/ai-cockpit-learning-effect-audit-2026-09-14.md`（含第二轮交叉核对后的 19 条发现）
> 本文性质：**修复方案，不是代码改动**。本轮未修改任何源码、测试与数据。
> 排序原则：先让"学习效果"变得**可度量**，再让结论**能回流**，最后才是可靠性与成本。

---

## 0. 开工前必须先定的 3 个决策

这 3 件事决定后面一半改动的形态，建议先拍板，否则会在实现中途返工。

| # | 决策 | 选项 | 影响面 | 本文建议 | **最终决定（2026-09-14）** |
| --- | --- | --- | --- | --- | --- |
| D-1 | "掌握 / 保持"的口径 | (a) 客观判题为主、自评并列展示；(b) 维持自评为主，仅补充客观指标 | (a) 会改变界面文案与用户心理预期；(b) 改动小但效果结论仍不可信 | **选 (a)**，但两个数字**必须同时可见**，不允许合并成"掌握率" | **选 (b)：维持自评为主。** 客观指标照常计算并入库；界面一字不改（现有文案已明示"用户自评保持率"）。实现口径与代价见 **§9.2** |
| D-2 | 系统能否**自己生成**反馈事件 | (a) 允许（新增 `source: "verification-decay"` 等）；(b) 不允许，只能提示用户点一下 | (a) 需要改正式数据含义 → 按 `docs/新的方案.md §19` 必须**先改产品文档并重新确认**，且涉及云同步契约；(b) 无契约变更 | **先选 (b)**（批次 C），(a) 留待产品确认 | **按 (b) 执行。** 系统不代笔生成反馈事件，只提示用户点一下 |
| D-3 | 是否让深度/快速角色用**不同模型** | (a) 分模型；(b) 不分，删掉误导性的 `AiRoleConfig.providerId/model` | (a) 要加设置入口；(b) 要改同步实体（`AiRoleConfig` 已同步） | **本方案不动**（见 §5 延后项），但建议尽快二选一 | **本轮不动**，留待 A/B/C 真实数据出来后再议 |

### 0.1 补充说明：D-1 的"口径"到底在决定什么

> **最终决定（2026-09-14）：选 (b) 维持自评为主。**
> 本节以下内容保留为**决策依据的完整记录**。其中"口径 B 会在界面显示两个并列数字"的描述**不会发生**；实际实现为：客观指标照常计算并入库，但**界面不展示**、只用于内部归因与回流。落地口径见 §9.2，完整契约见 `docs/ai-cockpit-data-semantics-pre-stage-2026-09-14.md` §1.2。
> 另注：D-1 行"本文建议"列记录的是当时的建议 (a)，**未被采纳**；D-2 / D-3 两行的建议则被采纳。

"口径"= **界面上那个"掌握率 / 保持率"百分比，分子与分母分别取哪些事实**。

同一次训练其实同时产生了三份证据，系统目前只用了一份：

| 证据来源 | 现在是否进入统计 | 存放位置 |
| --- | --- | --- |
| ① 用户按钮自评（训练结束点"已掌握"、验证时点"仍然掌握"） | **是，且是唯一来源** | `TaskOutcomeEvent(kind=self-assessment)` |
| ② AI 对每一轮作答的判题（`correct/partial/incorrect/unreliable`） | **否**（已存库，从未聚合） | `TaskOutcomeEvent(kind=answer-assessment)` |
| ③ 延迟验证那一轮新题的客观表现 | **否**（同上） | 同上，通过验证任务的轮次产生 |

于是会出现同一场训练里三份证据互相矛盾、而界面只报一个数字的情形。举例（对应批次 A-2 的 `masteryAssessmentBreakdown`）：

```
训练结束 → 用户点「已掌握」        → 现在记：即时掌握 +1
同一场最后一轮 → AI 判「部分正确」   → 现在：丢弃
3 天后验证 → 用户点「仍然掌握」      → 现在记：保持 +1
验证新题 → AI 判「答错」            → 现在：丢弃
界面结论：掌握 1 次 · 保持率 100%
```

按口径 B 之后，同一批事实会显示成两个并列数字：`自评保持率 100%（1/1）` 与 `客观答对率 33%（1/3）`。**两者的差距本身才是可用的教学信号**——差距大说明"自评"不能当作回忆能力的证据，也说明当前教法没有真的建立提取能力。

> ⚠️ **上面这段是"若选 (a) 会看到什么"的说明，不是本轮实现。** 本轮选 (b)：这两个数字**都会被算出来并入库**，但界面**只显示自评那一个**，客观那个不展示。差距信号因此只对系统内部可用（供 B-2 换教法），**不传达给用户**。

因此 D-1 真正要决定的是：

- **选 (a)（本方案建议）**：接受界面上同时出现两个可能不一致的数字，并在文案上解释口径。好处是系统第一次能说真话，也是 F-01（效果回流规划）有意义的**前提**——如果把自评当作效果输入规划，等于让模型学习"用户的主观感觉"，而不是"什么样的教法真的有效"。
- **选 (b)**：维持只有按钮一个数字。改动最小，但"是否真的学会"这个问题在系统内部永远无法回答，批次 A/B 的收益会减半（A 只解决记录、B 只能回流主观数据）。

补充一条同样属于口径问题的现状：冲突拦截**只针对 `incorrect`**（`orchestrator.ts:823`、`857`）。最后一轮被判 `partial`（部分正确）或 `unreliable`（无法可靠判定）时，用户点"已掌握 / 仍然掌握"**连二次确认都不需要**，直接写成正式事实并进入保持率分子。这是口径 B 需要一并覆盖的场景。

### 0.2 风险评估：把客观判题纳入统计，会引入什么风险

**先纠正一个前提：本方案里没有"引入 AI 判题"这一步。**

AI 判题**每答一轮就在跑**（`orchestrator.ts:774` 调用 `evaluateAnswer`），结果**已经写进正式库**（`TaskOutcomeEvent(kind="answer-assessment")`，`:781-785`），而且**已经有三个正式后果**：

1. **拦截自评**：末轮判 `incorrect` 时，"已掌握 / 仍然掌握"必须二次确认（`orchestrator.ts:823`、`857`），并在提交事务时由 `validation.ts:256` 再校验一次。
2. **决定验证时机**：`verificationPolicy.ts:30-33` 判 `incorrect` 就延长间隔；`partial` / `unreliable` / 用过提示按另一档处理。
3. **作为历史回给下一轮出题**：`orchestrator.ts:701-704` 把 `assessment` 与 `assessmentRationale` 放进 `previousTurns`。

方案实际只做三件事：**A-1 多给评估器一份材料**、**A-2 把已经存在的结果聚合到投影（零新增模型调用）**、**B-2 把门槛达标的效果摘要作为规划只读输入**。

所以真问题是"**AI 判题的数据第一次被拿来做统计和回流**"，而不是"第一次有 AI 判题"。

| 风险 | 是否成立 | 主因是否本方案引入 | 事实依据 | 方案中的对策 |
| --- | --- | --- | --- | --- |
| ① 提示词污染 | **成立** | **否，既有** | `aiClientService.ts:64-69` 全局 SYSTEM_PROMPT 以 `role:"system"` 无条件注入（`:224`），要求 Markdown + LaTeX + 结尾列来源；驾驶舱各角色却在 user 消息里要求"只输出 JSON"（`quizExecutionGateway.ts:27`）。system 优先级高于 user，5 个角色全部在被污染的指令环境里工作 | 批次 C-1（加独立 role system prompt，是**减污**）；A-1 新增的一句指令必须单独验收 |
| ② 数据源污染 | **分三种，只有一种成立** | **否**（成立的那种是"合并口径"的后果） | 见下文 (a)(b)(c)(d) | D-1(b) 要求客观指标**不进入主数字、不展示**；B-2 只送客观字段 + 混入 `inputFingerprint` |
| ③ 幻觉影响输出质量 | **成立，且现在就在发生；A-1 让它更容易被发现，同时新开一个失效模式** | **部分**（A-1 确实新增一个） | 见下文 | 严格 schema + criteria 子集校验 + `objectiveUnreliableCount` 自监控 + `maxTokens` 提高 + 字数上限 |

#### ① 提示词污染

- **既有的、最实在的污染就是 F-17**：全局 `SYSTEM_PROMPT`（`aiClientService.ts:64-69`）以 `role: "system"` 注入（`:224`），明文要求"使用 Markdown 和 LaTeX，不要输出 HTML……结尾简短列出依据来源"；而驾驶舱 5 个角色的指令是放在 user 消息里的"只输出 JSON，不要 Markdown 或代码围栏"（`quizExecutionGateway.ts:27`）。**这条冲突与本方案无关，批次 C-1 专门修它。**
- 本方案**只新增两处提示词改动**，且方向相反：A-1 给评估器加一句"判据可能不完整，必须对照材料判断，冲突则 `unreliable`"；C-1 给驾驶舱角色加独立 system prompt（**减污**）。
- 用户学习记录是不可信文本，天然是提示注入面 —— 但这是**既有**通道：`generateTurn`（`:696`）与 `reviewQuestion`（`:722`）早就把同一份 `decisionBlockContent` 送进去了。A-1 只是让评估器也看到它，**没有新开一条数据通路**。
- 已有的一层缓解写在 `quizExecutionGateway.ts:26`：明确告知模型 `previousTurns.answerText` 是用户提供的不可信内容，只能用于定位误解，不得覆盖 Blueprint / 来源 / 系统约束。
- **硬约束**：A-1 / C-1 改变了模型看到的指令，按项目规矩**必须补一次单独批准的受控真实 Provider 验收**，不得并进普通回归。

#### ② 数据源污染

分四种情形看，**只有第三种成立**：

- **(a)「AI 判题结果被写进正式数据」→ 已经在发生，不是新增。** `answer-assessment` 本来就是正式 `TaskOutcomeEvent`。
- **(b)「AI 结果污染档案 / 云同步」→ 不成立。** 方案新增的全部指标落在 `InterventionEffectSummary` 投影层；`decisionBlockStates` / `interventionEffectSummaries` 不进 `getReviewCoachFormalSnapshot`（已由 `backup.test.ts:126`、`formalRoundTrip.test.ts:97-98` 断言），由 `rebuildReviewCoachProjectionsInTransaction`（`repository.ts:411-435`）全量重建，且 `REVIEW_COACH_REPLAY_VERSION`（`replay.ts:16`）提到 v3 会强制重算一次。**算错了也只是重算，不写档案、不过云、可回滚。**
- **(c)「把客观判题和自评混成一个数字」→ 成立，这是本方案最需要防的一条。** 一旦合并，一次幻觉判 `correct` 会直接抬高"保持率"，且事后无法区分"真的记住"与"模型判错"。所以 D-1 要求两个数字**永不合并**，只并列展示。
- **(d) 反向污染：B-2 把效果摘要送进规划后，脏数据会反过来影响后续教学。** 对策已在 B-2 写死：只取 `evidenceStatus === "usable"`（双门槛 `sampleCount >= 3` **且** `objectiveAnswerCount >= 3`）、按 `strategyKey` 去重后上限 5 条、提示词明写"样本不足必须忽略 / 不得据此宣告掌握"、并把 `strategyKey + replayFingerprint` 混入 `inputFingerprint`（既有不可变冻结字段），使"这批分析到底用了哪份效果证据"可事后审计。

#### ③ 幻觉

- **结构性护栏已经比较严**：`parseAnswerEvaluationAiResponse`（`aiSchemas.ts:408-420`）要求精确键、`assessment` 必须是 `correct|partial|incorrect|unreliable` 四值之一、两个 criteria 必须是字符串数组；`orchestrator.ts:777-778` 再校验 `matchedCriteria` / `missingCriteria` **必须逐字来自 `turn.answerCriteria`**。唯一自由文本 `rationale` **不参与任何计分**，只做展示与历史。
- 因此幻觉的实际杀伤面被压到"**`assessment` 这一个枚举值判错**"。
- **而这个风险现在就在发生**：`turn.answerCriteria` 是出题模型自己产出的（`:745` 来自 `response.answerCriteria`），评估器只看这份判据（`:774` 的 input 不含材料）→ 判据一错，评分就"自洽地错"，从外部看不出来（这就是 F-18）。A-1 的目的正是削弱它：让评估器能反驳判据，并允许多判 `unreliable`。
- **诚实地说，A-1 会新开一个失效模式**：材料变长导致上下文稀释，可能反而判得更不准；也可能评估器过度听从材料、否定一条本来有效的判据。对策：`maxTokens` 1000 → 1400、**先做字/预算上限**（复用 F-11 的预算函数）、并把 `objectiveUnreliableCount` 作为**自我监控指标**——若 `unreliable` 占比偏高，说明 A-1 没解决问题，应当回退或再改提示词。
- **另一个现状混淆**：`skipQuizTurn` 也写 `unreliable`（`:797`，"用户跳过本题，未形成可判断的作答证据"）。所以 `unreliable` 同时混合了"模型判不了"和"用户跳过"两种语义。因此客观答对率的**分母必须排除 `unreliable`**（A-2 已如此规定），否则用户会因为"模型能力不足"或"自己点跳过"被计成答错 —— 那是**指标引入的新不公正**，比现在的失真更糟。

#### 小结（回答"会有这些情况发生吗"）

三个风险都真实存在，但**没有一个是"因为要引入 AI 判题"才出现的**：

- 最能立刻伤人、且**现在就在发生**的是 **F-17 提示词污染**（批次 C-1）与 **F-18 判据自洽导致的判错**（批次 A-1）；
- 最需要用户拍板才能防住的是 **(c) 客观与自评不得混算**（D-1）；
- 真正低风险的只有 **A-2 本身**：不调模型、不写正式数据、可重算、可回滚。

因此落地顺序不变，但补一条硬约束：**A-1 / C-1 的验收不能只看测试绿**，必须在一次单独批准的受控真实 Provider 验收里人工复核若干条判题（材料前后对比），把**幻觉率与 `unreliable` 率**作为验收指标。

---

## 1. 优先级矩阵

按"对学习效果的实际影响"排序，而不是按发现编号。

| 批次 | 主题 | 包含发现 | 为什么排这个位置 |
| --- | --- | --- | --- |
| **A** | 让效果**可度量** | F-18、F-02、F-14 | 现在系统里的"掌握/保持率"全部由自评按钮产生；而客观判题**已经存好了**。这一批做完，系统第一次能回答"是否真的记住" |
| **B** | 让结论**能回流** | F-08、F-01、F-03 | A 产出的证据只有进到规划里才叫闭环；F-08 是回流输入的可靠性前提，F-03 补上"衰退→再教"的缺口 |
| **C** | 让用户**真的拿到练习**且证据不被污染 | F-17、F-04、F-06、F-20、F-19 | 前两条是已定位的确定性失败源（做不上题 + 重复计费）；后三条决定"答对"能否归因于回忆 |
| **D** | 数据与交互完整性 | F-09、F-11、F-15、F-05(费用部分) | 闭环断裂无提示、超大块撑爆请求、验证被无限推迟、费用无熔断 |
| **延后** | 架构与配置 | F-10、F-12、F-13、F-05(其余) | 需要产品决策或较大重构，收益不如 A/B/C 直接（见 §5） |

---

## 2. 批次 A：让效果可度量

### A-1（F-18）把原始材料交给答案评估器

**问题**：`submitQuizAnswer` 只把 `{blueprint, question, answerCriteria, answerText, hintsUsed}` 交给评估器（`orchestrator.ts:774`），而同链的 `generateTurn`（`:696`）与 `reviewQuestion`（`:722`）都传了 `decisionBlockContent`。蓝图里的 `evidence` 只有 `excerptHash`，无法还原文本。于是"出题模型自写判据 → 评估模型只在判据内部自洽"→ 判据一错，评分跟着错。

**改动**

1. `src/hooks/useAppData.ts` — `submitAdaptiveQuizAnswer`：像 `generateAdaptiveQuizTurn` 那样取 `task` + `record`，用 `buildDecisionBlockAiContextPack(record, task.decisionBlockId, assets).markdown` 构造材料，传入 orchestrator。
2. `src/features/reviewCoach/orchestrator.ts` — `submitQuizAnswer`：接收 `decisionBlockContent`，在 `evaluateAnswer({...})` 的 input 中加入该字段（与 `generateTurn` 的字段名保持一致）。
3. `src/features/reviewCoach/quizExecutionGateway.ts` — `evaluateAnswer` 的指令文本增加："判据（answerCriteria）是出题者提供的，可能不完整或不准确；必须同时对照 decisionBlockContent 判断，若判据与材料冲突，或材料不足以覆盖该判据，assessment 必须为 unreliable 并在 rationale 中说明。"同时把 `maxTokens` 从 1000 提到 1400（材料变长，理由要写清）。
4. **必须先做**：给这次调用加上下文字数上限。复用批次 D 的 F-11 预算函数（若 D 未先做，则在本批内先抽出 `assertTurnContextBudget()`）。

**不要做**：不要把材料塞进 blueprint（那会改同步实体）；不要为了对齐材料而修改用户答案。

**验收测试**（`quizExecutionGateway.test.ts` / `stage6Orchestrator.test.ts`）
- 断言 `evaluateAnswer` 收到的 input 含 `decisionBlockContent`。
- 断言指令文本包含"判据可能不准确""对照材料"两个关键约束。
- 断言材料为空/超预算时在调用 Provider 之前抛错（不产生费用）。

**风险**：评分变严之后，`incorrect`/`unreliable` 比例会上升。这是**期望行为**（更诚实），但会连带影响 `verificationPolicy` 的窗口计算（错误 → 6/18 小时），需在验收时对同一批 mock 事实做前后对比并记录差异。

### A-2（F-02）效果摘要同时输出客观与自评两组指标（不合并）

> **口径以 D-1(b) 为准（2026-09-14 定稿）**：主口径仍是自评、**界面一字不改**；客观指标只入库、只用于内部归因。本节第 2 条与第 4/5 条已按此修订，原"双门槛"与"并列展示"方案**作废**。完整契约见 `docs/ai-cockpit-data-semantics-pre-stage-2026-09-14.md` §1.2。

**问题**：`replay.ts` 的 `immediateMasteredCount` 数自评 `mastered`；保持率来自用户在验证页点的按钮。`answer-assessment` 事件在整个 `replay.ts` 里没有聚合点。

**改动**（全部在投影层，**不触碰任何同步实体**）

1. `src/features/reviewCoach/domain.ts` — `InterventionEffectSummary` 增加字段：
   - `objectiveAnswerCount`：被纳入统计的 `answer-assessment` 事件数；
   - `objectiveCorrectCount` / `objectivePartialCount` / `objectiveIncorrectCount` / `objectiveUnreliableCount`；
   - `objectiveCorrectRate?: number`（分母为 `objectiveCorrectCount + objectivePartialCount + objectiveIncorrectCount`，**不含 unreliable**）；
   - `verificationObjectiveCount` / `verificationObjectiveCorrectCount` / `verificationObjectiveCorrectRate?`：验证轮同样口径；
   - `objectiveEvidenceStatus`：**独立的**客观可用性门槛（`objectiveAnswerCount >= 3`）；
   - `selfReportedMasteredCount`（原 `immediateMasteredCount` 重命名，**保留旧名作为别名以免 UI 编译中断**）；
   - `masteryAssessmentBreakdown`：自评 `mastered` 时末轮判题的分布（`correct/partial/incorrect` 计数）。
2. `src/features/reviewCoach/replay.ts` — 在现有 `groups` 循环内聚合上述字段。
   **`evidenceStatus` 的语义一行不改**（仍为 `sampleCount >= 3`）：它是**主数字**（自评）的可用性门槛，若挂上客观门槛，"有自评但客观样本少"的块会把**用户可见的主数字**降级 —— 与 D-1(b) 直接冲突。
3. `src/features/reviewCoach/replay.ts` — `REVIEW_COACH_REPLAY_VERSION` 由 `"review-coach-replay-v2"` 提升为 `"review-coach-replay-v3"`，使 `areProjectionsCurrent()`（`repository.ts:1315`）在升级后强制重建一次。
4. **界面不改。** `ReviewCoachWorkbench.tsx:273-289` 现有文案本身就是"用户自评保持率 N%（X/Y）"与"验证样本较少：用户自评保持 X / Y"，**已经明示是自评**，无需调整措辞。客观指标仅供内部归因（B-2）与后续决策使用。

**为什么不需要 schema 升级**：`decisionBlockStates` 与 `interventionEffectSummaries` 不在 `getReviewCoachFormalSnapshot` 里，`backup.test.ts:127` 与 `formalRoundTrip.test.ts:98` 已断言它们不进正式快照；它们由 `rebuildReviewCoachProjectionsInTransaction` 全量重建（`repository.ts:411-435`）。加字段只是行结构变化。

**验收测试**（新增 `replay.effectMetrics.test.ts`）
- 同一任务内 `answer-assessment: correct/partial/incorrect` 各一条 + 自评 `mastered` → 断言客观率 `1/3`、自评计数 `1`、`masteryAssessmentBreakdown` 为 `{correct:1,partial:0,incorrect:0}`（末轮）。
- 只有自评、没有作答事件 → 断言 `objectiveAnswerCount === 0` 且 `objectiveEvidenceStatus === "insufficient"`，**同时 `evidenceStatus` 不受影响**（这条断言是 D-1(b) 的护栏）。
- `unreliable` 不进客观率分母（构造 1 correct + 1 unreliable → 断言 `objectiveCorrectRate === 1`）。
- 断言 `retentionRate`（自评）与 `verificationObjectiveCorrectRate`（客观）在构造冲突数据时**不相等**。
- **顺序无关性**：对同一事实集合打乱顺序 → 断言投影完全一致（见前置文档 §2.4 约束 1）。
- `repository.test.ts:543` 已用 `objectContaining`，无需改动（已核实）。

**风险（已按 D-1(b) 重新定性）**：这是**内部指标增加**，不是**用户可见行为变化**。真正的风险转移到了 B 批：一旦 `planSession` 收到客观指标，教法会随客观证据变化，而用户在界面上看不到这个依据 —— 所以 B-2 必须只送客观字段、且必须带样本量。**

### A-3（F-14）效果归因到实际发生的题型与策略

**问题**：`strategyKey` 只含 `initialPracticeType`（`replay.ts:179`），不含每轮真实 `practiceType`，也不含实际用到的策略（`continue/hint/explain/worked-example/prerequisite-check`）。

**改动**

1. 在 `InterventionEffectSummary` 增加**按实际轮次**的分组统计（同一次重建内产出多条，用 `strategyKey` 区分）：
   - `strategyKey` 追加两段：`actualPracticeType`（该任务中出现次数最多的 `AdaptiveQuizTurn.practiceType`）与 `hintLevelUsed`（`none | hint-only | explain-or-worked-example`，由该任务的 `hintsUsed` 与随后的分支策略推导）。
   - 由于策略**当前没有落到轮次上**（F-05 的一部分），本批先做"题型 + 是否用提示"两个维度；策略维度依赖 F-05 的返回体扩展，放到批次 D 一起做。
2. `averageTurnsToMastery` 排除 `[skipped]` 轮（`replay.ts:202`），`averageHintsUsed` 保持现状但补一条注释说明分母是全部轮次。

**验收测试**：同一 `problemType` 下构造"变式题 + 无提示"与"概念题 + 用了提示"两组任务，断言产出两条独立的 `strategyKey` 且各自计数正确。

---

## 3. 批次 B：让结论能回流

### B-1（F-08）修正投影优先级：新反馈必须能压过旧结果

**问题**：`replay.ts:78-101` 先按事实算基线（有新反馈 → `needs-analysis`），随后把结果事件按时间顺序 apply，**后写覆盖前写**。于是"T1 自评已掌握 → T2 又写新困惑"的块，投影仍是 `improved-pending-verification`。

**改动**（`replay.ts:62-134`，改为显式优先级裁决）

```
1. block.deletedAt            → stale
2. 存在 current/in-progress 任务 → learning（任务在跑优先，保持现状）
3. lastContentEventAt < lastFeedbackAt → needs-analysis（新反馈未被处理，最高业务优先级）
4. 否则：按时间顺序 apply 自评/验证完成事件（保留现有语义）
5. 兜底：有 accepted 蓝图 或 waiting/deferred 任务 → planned；否则 unassessed
```

其中 `lastContentEventAt` = 最新的自评或已完成验证时间（`replay.ts:86-100` 的同一批事件），`lastFeedbackAt` = `activeFeedback.at(-1)?.occurredAt`。

**验证不改坏现有断言**（已核对）：
- `repository.test.ts:72,123`：库里只有块 + 反馈，无结果事件 → 仍为 `needs-analysis`。
- `repository.test.ts:470,499`：反馈 `occurredAt = 2026-09-04T08:00`，结果事件 `10:00`（更新）→ 结果仍胜出，断言不变。
- `repository.test.ts:542`：验证完成 `2026-09-07T08:04` 晚于反馈 → `retained` 不变。
- 因此本批**只需新增**用例，不需要改既有断言。

**新增测试**（`replay.projection.test.ts`）：块在 T1 完成训练并自评掌握、T2 新增一条反馈（时间更晚）→ 断言 `status === "needs-analysis"` 且 `lastFeedbackAt` 为 T2。

### B-2（F-01）把效果摘要作为深度规划的只读输入

**问题**：`planSession` 的 input 只有 `blocks` 与 `allowedSupportingDecisionBlockIds`（`sessionPlanningGateway.ts:29-50`、`orchestrator.ts:475-502`）。文档 §12 的"历史效果反过来影响下一次教学策略"未实现。

**改动**

1. `src/features/reviewCoach/sessionPlanningGateway.ts`
   - `SessionPlanningPromptInput` 增加 `interventionEffects: Array<{...}>`（只含 `evidenceStatus === "usable"` 的条目，且按 `strategyKey` 去重、上限 5 条）。
   - 提示词增加一段明确定位："以下 effectSummaries 是**该用户的历史干预效果**，仅用于**在同一学习目标内部**选择训练方式与难度；不得据此改变主决策块、不得据此宣告掌握、样本不足时必须忽略。"
2. `src/features/reviewCoach/orchestrator.ts` — `analyzeFeedback`：把已有的 `existingSnapshot`（`:452`）送进 `replayInterventionEffectSummaries({...})`，按主块的 `difficultyType` 过滤后传入 `planSession`。为省算力，**每次 analyzeFeedback 只算一次**，在子批次循环外。
3. `src/features/reviewCoach/analysisPlanner.ts` — `planAnalysisBatches` 的 `inputFingerprint` 计算中加入 `effectSummaries.map(item => item.strategyKey + ':' + item.replayFingerprint)`。这样"这批分析用了哪份效果证据"随既有的**不可变冻结指纹**一起被审计，**无需新增同步字段、无需 schema 升级**。

**放弃与取舍**
- 不做"把效果摘要写进 `SessionBlueprint`"（`SessionBlueprint` 是同步实体，加字段＝改同步契约＋schema 升级）。若后续确实需要逐条追溯，再走 schema 22 + 同步协议评审。
- 不在本批做"用效果自动改 `priorityTier`"。文档 §9.2/§19 明确"优先级由本地规则分层"，且效果样本稀少，贸然自动改优先级会放大噪声。

**验收测试**（`sessionPlanningGateway.test.ts` / `stage6Orchestrator.test.ts`）
- 构造 `evidenceStatus: "usable"` 的效果摘要，断言 `planSession` 收到的 input 含该摘要。
- 构造 `insufficient` 的效果摘要，断言**不出现**在 input 里。
- 断言同一批 `blocks` 但不同效果摘要 → `inputFingerprint` 不同（证明证据进入冻结边界）。
- 断言提示词文本包含"不得据此改变主决策块 / 不得宣告掌握"。

**这项是本方案里"学习效果"回报最大的一条**：做完之后，系统才第一次具备"因为某种教法在你身上无效，所以换一种"的能力。

### B-3（F-03）让"衰退"回到重新规划（按 D-2 选 (b)）

**问题**：`completeDelayedVerification` 判 `decayed` 时只写事件与投影（`orchestrator.ts:850-869`），不产生反馈、不入队列；`AnalysisEligibilityReason` 里的 `delayed-verification-decay` 与 `replan-after-failure` 全仓无引用。

**改动（零契约变更版）**

1. `src/features/reviewCoach/orchestrator.ts` — `completeDelayedVerification` 在 `decayed` 分支后调用 `selectNextTask()`（已有）之外，**不做静默写入**。
2. `src/features/reviewCoach/replay.ts` — 新增派生查询 `listDecayedBlocksNeedingReplan(snapshot)`：条件为"最新一条已完成验证为 `decayed`，且其后没有更新的反馈、没有 accepted 蓝图、没有 open 任务且内容版本一致"。输出 `{decisionBlockId, recordId, contentVersion, decayedAt}`。
3. `src/features/reviewCoach/ReviewCoachWorkbench.tsx` — 新增"需要重新规划"区块：列出上述块，提供"补充说明并加入分析"按钮，点击后复用现有 `onAnalyze` 确认流程；用户在 `AnalysisQueueItem.analysisNote` 里写一句卡点（`analysisNote` 已存在且属同步字段，无契约变更）。
4. 若用户不理会，该块保持 `needs-consolidation` 投影并在工作台持续可见——**可见即可行动**，不制造假的学习结果。

**明确的边界**：本批**不**创建由系统代笔的 `DecisionBlockFeedback`。若产品决定走 D-2 的 (a)（允许系统生成反馈事件），必须先改 `docs/新的方案.md §19` 的冻结边界并重新确认，因为那会改变正式数据的含义与同步语义。

**验收测试**：构造 `decayed` 验证 + 无后续事实 → 断言 `listDecayedBlocksNeedingReplan` 命中；再补一条更晚的反馈 → 断言不再命中。

---

## 4. 批次 C：让用户真的拿到练习，且证据不被污染

### C-1（F-17）给驾驶舱角色独立的 system prompt

**问题**：`buildAiMessages` **无条件**注入全局 `SYSTEM_PROMPT`（`aiClientService.ts:224`），其内容要求"使用 Markdown 和 LaTeX""结尾简短列出依据来源"（`:68`），与各网关"只输出 JSON、不得增加其他字段、闭卷不得给答案"正面冲突。

**改动**

1. `src/services/aiClientService.ts`
   - `SYSTEM_PROMPT` 改名 `CHAT_SYSTEM_PROMPT`，保留为默认值。
   - `AiCompletionRequestOptions` 增加 `systemPrompt?: string`；`buildAiMessages(attachment, history, prompt, memoryTurns, memorySummary, nextContent, systemPrompt?)` 用传入值替换默认。
   - `sendChatCompletionDetailed` 透传 `options.request?.systemPrompt`。
2. 新增 `src/features/reviewCoach/rolePrompts.ts`，导出 `REVIEW_COACH_ROLE_SYSTEM_PROMPT`：
   "你是一个结构化数据生成器，为本地学习日志应用输出 JSON。只输出一个 JSON 对象，不要 Markdown、不要代码围栏、不要 LaTeX、不要在 JSON 之外追加任何文字（包括来源列表）。不得改变输入中给定的目标、来源引用与版本；信息不足时按输入要求返回 insufficient-context。"
3. 5 个网关（`aiGateway.ts:67`、`sessionPlanningGateway.ts:54`、`quizExecutionGateway.ts:32`）统一传入该 role prompt。

**验收测试**（新增 `aiClientService.systemPrompt.test.ts`）
- 驾驶舱调用 → 断言第一条 system 消息**不含** "Markdown"、"LaTeX"、"列出依据来源"。
- 普通问答调用（不传 `systemPrompt`）→ 断言行为与改动前一致（防止回归）。
- 五个网关各自的测试补一条"请求带 role prompt"。

**回归风险（必须记录）**：这会改变模型看到的指令，属于 `AGENTS.md` 定义的"受控真实 Provider 验收"范围。**批次 C 合并后需要一次单独批准的付费验收**（deepseek-v4-flash，1 个决策块 × 1 轮出题 + 1 次判题），并把结果写入 `docs/` 的验收记录。

### C-2（F-04 + F-07）出题提示词与 schema 同源

**问题**：提示词把 `practiceType` 写成 `concept|calculation|discrimination|cloze|variation|chunk`（`quizExecutionGateway.ts:47`），与 `practiceTypes`（`aiSchemas.ts:127-135`）不一致，其中 3 个值非法；`structuredOutput` 只发 `response_format:{type:"json_object"}` **不带 enum**（`aiClientService.ts:387`），模型只能照文本走；非法值抛 `AiSchemaError`（`aiClientService.ts:52-54`，`retryable=false`），而出题循环没有 try/catch（`orchestrator.ts:692-709`），异常直达 UI 并已计费。

**改动**

1. `src/features/reviewCoach/aiSchemas.ts` — 导出 `practiceTypes`（当前为模块内常量）与 `answerModes`。
2. `src/features/reviewCoach/quizExecutionGateway.ts` — `generateTurn` 的指令文本改为模板拼接：`practiceType` 取值来自 `practiceTypes.join("|")`，`answerMode` 取值来自 `answerModes.join("|")`。同时把 `requestedStrategy` 与 `initialPracticeType` **拆成两个字段**（F-07），`requestedStrategy` 只允许蓝图策略枚举，缺省时不传该字段而不是塞题型。
3. `src/features/reviewCoach/orchestrator.ts:706` — 首轮改为 `requestedStrategy: branch?.nextStrategy`（首轮无分支即不传），题型由 `blueprint.initialPracticeType` 单独放在 payload 里（蓝图本身已含该字段，无需重复传）。

**验收测试**
- 新增断言：`buildQuizTurnPrompt` 中出现的 `practiceType` 取值集合 **严格等于** `practiceTypes`（顺序无关），`answerMode` 同理。这条测试是防止再次漂移的关键。
- 断言首轮 input 中 `requestedStrategy` 不属于 `practiceTypes`（即类型不再混用）。
- 现有 `quizExecutionGateway.test.ts` 的 mock 返回 `practiceType: "variation"`，仍然合法，无需改。

### C-3（F-06）给 `unreliable` 明确的分支语义（**2026-09-14 修订：原"降级为 partial"方案作废**）

**问题**：`BlueprintBranch.when` 只有 `correct|partial|incorrect|skipped`（`domain.ts:172`），AI 判 `unreliable` 时 `branch` 为 `undefined` → **静默**落到 `"continue"`（`orchestrator.ts:688-689,706`）。F-06 的实质不是"fallback 选错了"，而是**"判不了"与"没有判定"不可区分**。

**原方案为什么作废**：我原本打算把 `unreliable` 本地映射为 `partial` 分支。这是错的——`partial` 的语义是"部分答对，走提示/讲解"，而 `unreliable` 的语义是"模型判不了或用户跳过"。把后者当后者处理，会让**未判定的数据去驱动教学决策**，直接污染掌握判定与策略选择。

**改为三条独立约束**

1. **不进作答命中率的分子或分母**（A-2 已落地：分母排除 `unreliable`）。
2. **不自动升高或降低难度**，也不自动进入/退出"掌握"判定。
3. **触发一次"再验证"而非"改策略"**：
   - 先让模型在更完整的材料下重判一次（A-1 之后评估器已拿到 `decisionBlockContent`）；
   - 重判仍是 `unreliable` → 向用户提示"这道题暂时无法可靠判定"，该轮标为**不可评估**，**不写任何策略决策**、不推进难度、不改变掌握结论；
   - 该轮必须留下显式记录（策略原因字段 / 事件 reason），使"判不了"不再与"没有判定"混同 —— 这是 F-06 的真正修复点。

**`BlueprintBranch.when` 是否新增 `unreliable`**：取决于第 3 条落地后是否仍需本地分支。若"再验证 + 显式记录"已能表达全部语义，则**不新增**，保持分支表最小、避免改同步实体 `SessionBlueprint`。

**记录但本轮不改的既有不一致**：`verificationPolicy.ts:33` 把 `unreliable` 与 `partial` 按同一档延后验证间隔。那是**时间安排**而非掌握判定，属于保守处理，可接受；但它与 C-3 的新语义口径不同，**必须在本轮文档中登记为已知不一致**，避免后人误读。

**验收测试**：上一轮 `assessment === "unreliable"` 时，断言**没有**选出 `partial` 分支的策略、**没有**推进难度、**没有**产生掌握判定；且该轮存在显式的"不可评估"记录。

### C-4（F-20）本地答案泄漏检查

**问题**：全仓检索 `泄漏|泄露|leak`，驾驶舱内唯一命中是提示词 `quizExecutionGateway.ts:46`。没有任何本地校验；"答案泄漏"也不在质检的 `severeIssues` 枚举里（`aiSchemas.ts:250`），且开放题不做质检（`orchestrator.ts:719`）。

**改动（按文档 §8.3：开放题做"本地结构校验和来源约束校验"）**

1. 新增 `src/features/reviewCoach/questionIntegrity.ts`：
   - `normalizeForLeakCheck(text)`：去空白、全角转半角、去标点、小写。
   - `findLeakedCriteria(question, hints, answerCriteria)`：任一条 `answerCriteria` 规范化后作为子串出现在题干或**任一 hint** 中即判泄漏。
   - `assertNoAnswerLeakage(candidate)`：泄漏时抛 `ReviewCoachValidationError("answer-leakage", ...)`。
2. `src/features/reviewCoach/orchestrator.ts` — 在 `generateTurn` 返回后、质检之前调用；泄漏视同质检失败：设置 `lastQualityReason = "题面或提示泄露了答案判据"` 并 `continue`（复用现有的"最多重生成一次"逻辑，不新增调用次数）。
3. `src/features/reviewCoach/aiSchemas.ts` — `severeIssues` 枚举增加 `"answer-leakage"`，供非开放题的 AI 质检一并返回。
4. 给用户可见的失败原因：复用现有 `formatActionableError(error, "adaptive-review")`（`src/lib/uiError.ts`），**不得**直接渲染 `error.message`（`AGENTS.md` 的硬约束，`uiErrorSurface.test.ts` 会拦截）。

**为什么不给所有开放题都加 AI 质检**：文档 §8.3 明确开放题只做本地校验，且每轮多一次付费调用会显著抬高成本。本地判据检查能覆盖最常见的一类泄漏（题干直接念出判据）。

**验收测试**（新增 `questionIntegrity.test.ts` + orchestrator 用例）
- 题干含判据原文（含全角/空格变体）→ 判泄漏。
- hint 第 2 级含判据 → 判泄漏。
- 题干引用来源材料但未含判据 → **不**判泄漏（避免误杀）。
- 泄漏时断言重生成只发生一次，第二次仍泄漏则抛出可读错误且**不再调用**。

### C-5（F-19）跨块引用的门禁真正生效

**问题**：子批次最多 3 块，prompt 会送出全部同批块的内容（`orchestrator.ts:476-500`）；但校验时 `feedbackIds` 的基准是 `blocks.flatMap(...)` 的**全批并集**（`:177`），只要求"至少命中一个主块反馈"（`:180`）；`interpretationIds`（`:178,183`）与 `evidence`（`:189-193`）同样是全批并集。于是 `allowCrossBlockSupport=false` 只关闭了 `supportingDecisionBlockIds`（`:173-176`）。

**改动**（`orchestrator.ts:158-197`）

```
const mainFeedback = new Set(main.feedback.map(f => f.id));
const mainInterpretations = new Set(main.feedback.map(f => f.interpretation?.id).filter(Boolean));
const allowIds = allowCrossBlockSupport ? 全批并集 : mainFeedback;
const allowInterp = allowCrossBlockSupport ? 全批并集 : mainInterpretations;

- feedbackIds：必须非空、必须全部 ⊆ allowIds（去掉"至少命中一个"的宽松条件）
- interpretationIds：必须全部 ⊆ allowInterp
- evidence：allowCrossBlockSupport=false 时，要求 every(e => e.decisionBlockId === main.decisionBlockId)
```

同时在 `sessionPlanningGateway.ts` 的提示词里显式写明："allowedSupportingDecisionBlockIds 为空时，你**不得**引用其他块的 feedback、interpretation 或 evidence。"

**为什么保留"仍把同批其他块送进 prompt"**：三个块各自都要产出蓝图，上下文必须齐备。限制引用而不是限制可见，是这里唯一可行的方式。

**验收测试**（`stage6Orchestrator.test.ts`）
- 2 块子批次 + `allowCrossBlockSupport=false` + 候选引用了另一块的 `feedbackId` → 断言被拒绝。
- 同样条件 + 候选只引用主块 → 断言通过。
- `allowCrossBlockSupport=true` + 引用另一块 → 断言通过（不误伤既有能力）。

---

## 5. 批次 D：数据与交互完整性

| 项 | 发现 | 改动要点 | 验收 | 备注 |
| --- | --- | --- | --- | --- |
| 批D-1 | F-09 | `buildAnalysisPlanningBlocks` 之外新增"失效但近期"的只读列表；工作台在块版本变化后显示"该重点已更新，历史评论与分析已失效"，并提供"带着旧评论重新发起分析"入口 | 组件测试：`contentVersion` 递增后断言提示出现且提供入口 | 不要自动重跑；不要把它做成错误提示（走普通提示样式，不经过 `uiError`） |
| 批D-2 | F-11 | 抽出 `assertTurnContextBudget(provider, markdown)`；`useAppData.generateAdaptiveQuizTurn` 在调用前校验，超限抛 `ActionableError` 提示"请拆分决策块或完成 OCR" | 超大块断言在调用 Provider 之前抛错 | 与分析路径的 `maxAnalysisInputTokensForProvider`（`analysisPlanner.ts:45-46`）保持同一套常量 |
| 批D-3 | F-15 | `refreshDueVerifications`：当某块到期的验证被自己的**延期任务**阻塞时，把该 deferred 任务提升为 `waiting`（`notBeforeAt = now`），让既有 `transitionTask → in-progress` 的验证联动（`repository.ts:940-947`）接上 | 断言 deferred 任务在被 due 验证阻塞时被提升，且不产生第二个 open 任务（唯一索引不被触发） | 不要在 `deferred` 与 `due-verification` 之间新建并行任务，会撞 `openTargetKey` 唯一索引 |
| 批D-4 | F-05（费用部分） | 在 orchestrator 依赖里加**会话级** token 计数（`generateTurn/reviewQuestion/evaluateAnswer` 的 usage 累加），超过 `blueprint.maxEstimatedTokens` 时终止当前任务的后续轮次并提示 | 断言累计超限后不再产生新的 AI 调用 | 持久化 per-turn token 需要给同步实体 `AdaptiveQuizTurn` 加字段 → **本批不做**。会话级计数重启即清零，需在 UI 文案中说明这是"本次会话内的保护" |
| 批D-5 | F-13 | 需要产品决策：现行"报错即终结整任务"符合文档 §10.3，但文档同句要求的"触发质检"未实现。选项 (a) 只失效该轮并重出一题（保留任务）；(b) 维持现状并修改文档措辞 | 依决策而定 | 属产品边界问题，按 §19 需先改文档 |

---

## 6. 明确延后（本轮不推荐做）

| 项 | 发现 | 延后理由 |
| --- | --- | --- |
| P-1 | F-12 投影写放大 | 收益是性能，不是学习效果。且注意：**如果 A-2/B-1 修改了重建算法，全量重算反而更安全**。建议 A/B 落地并跑一段时间、观测到明显卡顿后再做增量重算；`areProjectionsCurrent()`（`repository.ts:1307-1329`）是现成的安全网，先保留 |
| P-2 | F-10 深度/快速分模型 | 需要 D-3 决策 + 设置入口 + 可能改同步实体。当前最便宜的替代是**在提示词层面区分**（已具备），先把 A/B 做完再谈 |
| P-3 | F-05 其余字段（`maxRetriesPerTurn`、`forbiddenScope`、`expectedKeyPoints`、策略落库） | 其中"策略落库"需要给 `AdaptiveQuizTurn` 加同步字段（schema 升级 + 同步协议评审）。建议与 P-2 一起作为一个"教学策略可观测性"阶段统一设计，而不是零散加字段 |
| P-4 | F-16 效果摘要补 `unreliable` 分布之外的更多维度 | A-2/A-3 已覆盖主要维度，其余等真实样本积累后再按需加 |

---

## 7. 建议的发布批次与验证清单

> **顺序已按实施前复核调整**（2026-09-14）：改为 **P0 前置（锁定数据语义）→ P1 低风险（A-2/A-3）→ P2 中风险（B 批）→ P3 高风险（C 批）→ P4 验收**。理由：高风险项要放在测试保护更完整之后，且每项都要满足"若不满足就保持旧行为"的回退要求。完整说明见 `docs/ai-cockpit-data-semantics-pre-stage-2026-09-14.md` §5。

每批独立可验收、可回滚。遵循 `AGENTS.md` 的阶段纪律：定向测试 → 全量 `npm run test` → `npm run build` → 涉及交互再跑 Playwright。

**当前已复核的全量基线**：`npm run test` → `Test Files 169 passed | 2 skipped`、`Tests 1059 passed | 2 skipped`、**0 失败**（2 项 skipped 为付费 live 测试）。

| 批次 | 内容 | 验证 | 回滚方式 |
| --- | --- | --- | --- |
| **A** | A-1 → A-2 → A-3 | `npx vitest run src/features/reviewCoach`（基线已更新为 **17 文件 / 96 项全绿**）+ 新增 3 个测试文件 + `npm run build` | 纯代码 + 本地投影字段。回滚不影响正式事实，但**会改变用户看到的统计口径**（投影表被重建），须告知而非声称"无影响" |
| **B** | B-1 → B-2 → B-3 | 同上 + `sessionPlanningGateway.test.ts` 新增 4 条 + `replay.projection.test.ts` | B-2 只改提示词与指纹；回滚后旧批次仍可读（`inputFingerprint` 只是哈希） |
| **C** | C-1 → C-2 → C-3 → C-4 → C-5 | 同上 + **一次单独批准的受控真实 Provider 验收**（C-1 改变了模型看到的指令，必须重跑） | 提示词/校验类改动，回滚即恢复旧行为 |
| **D** | 批D-1 → 批D-4 | 同上 + Desktop/Android 窄屏 Playwright（涉及工作台与训练页交互） | 逐项独立，可单独回滚 |

**每批完成后的必做记录**：把"改了什么 / 客观指标的变化 / 是否触发真实 Provider 验收"写入 `docs/`，并同步 `AGENTS.md` 的当前基线段（该文件是团队的工程事实来源）。

**关于 AGENTS.md 中仍未关闭的发布门槛**：物理设备覆盖升级、受控真实 Firebase 账号账单核对、语音复述的手动输入与通话后动作等，仍是既有发布签字项。本方案的任一批次都**不改变**这些结论。

---

## 8. 一句话总结

**先做 A（让效果有客观证据）+ B（让证据能回流）**——这两批合计约 6 处改动，全部落在本地投影与提示词层，**不需要 schema 升级、不改同步契约**，却能把系统从"记录学习过程"推进到"用证据改进教学"；**C 批**修掉两条已定位的确定性失败源并堵住答案泄漏与跨块污染；**D 批**与延后项等 A/B/C 的真实数据出来后再排。

**口径附注（D-1(b)）**：这里的"客观证据"**只进入系统内部**。界面仍只显示自评数字，所以本轮的收益是"教法有依据"，**不是**"用户被指出自评不可靠"。若将来要让用户看到差距，只需在 `ReviewCoachWorkbench` 加一行字，数据届时已经在库里。

**实施顺序附注**：A/B/C 的顺序在实施前复核时被调整为 **P0 前置 → P1（A-2/A-3）→ P2（B）→ P3（C）→ P4 验收**，理由是高风险项要放在测试保护更完整之后。详见 `docs/ai-cockpit-data-semantics-pre-stage-2026-09-14.md`。

---

## 9. 最终执行计划（2026-09-14 拍板）

> 本节是**执行合同**。§1–§8 是方案论证与选项比较；本节是锁定后的落地口径。批 D 与延后项不在本轮。
> **前置必读**：`docs/ai-cockpit-data-semantics-pre-stage-2026-09-14.md`（数据语义契约与风险边界，实施前的 P0 门槛）。
> **当前状态（2026-09-14 收官）**：A / B / C 三批全部实现并通过本地验收（`tsc -b` 0 错误、全量 175 文件 / 1108 项 0 失败、build 成功）。付费 Provider 验收与文档交付见 `docs/ai-cockpit-remediation-acceptance-2026-09-14.md`。执行中的三处方案修正（B-2 门槛、B-3 说明落点、C-3 不做盲重试）均登记在该文档 §2。

### 9.1 锁定的执行参数

| 项 | 决定 |
| --- | --- |
| 修复范围 | **批次 A + B + C**，共 11 条发现。A＝F-18 / F-02 / F-14；B＝F-08 / F-01 / F-03；C＝F-17 / F-04+F-07 / F-06 / F-20 / F-19 |
| D-1 掌握口径 | **(b) 维持自评为主**，界面一字不改 |
| D-2 系统代笔反馈 | **(b)** 系统不代笔，只提示用户点一下 |
| D-3 深度/快速分模型 | 本轮不动 |
| 付费受控真实 Provider 验收 | **已授权**，由实现方按最小样本执行，结果写入 `docs/` |
| 推进节奏 | **全部做完统一验收**（中途不打断） |
| 提示词版本号 | bump `session-blueprint-v1→v2`、`quiz-turn-v2→v3`、`answer-evaluation-v1→v2`、`question-quality-v1→v2`。`feedback-interpretation-v1` **不 bump**（提示词文本未变，且不进 `strategyKey`） |
| 既有测试断言 | 允许修改，**仅限本项直接相关**，逐条在提交说明注明理由；冻结类测试（`teacherPrompt.test.ts`、`uiErrorSurface.test.ts`）一律不动 |
| A-1 输入预算 | 抽 `assertTurnContextBudget(provider, markdown)`，复用分析路径常量；评估器 `maxTokens` **1000 → 1400** |
| 界面文案 | 主卡片文案不变（D-1 选 b 的直接结果） |
| 知识播客 F-21 | **顺手一起修**（C-1b），独立可回滚 |
| **明确不做** | 扩展自评冲突拦截、schema 升级、同步契约变更、语音复述相关任何内容、批 D 全部 |

### 9.2 D-1 选 (b) 之后的实现口径（逐条落到代码）

1. **主口径不变。** `retentionRate`、`immediateMasteredCount` 的定义与计算**一行都不改**（`replay.ts:194,210-212`）。
2. **客观指标仍全部计算并入库**：`objectiveAnswerCount`、`objectiveCorrectCount`、`objectivePartialCount`、`objectiveIncorrectCount`、`objectiveUnreliableCount`、`objectiveCorrectRate`、`verificationObjectiveCount`、`verificationObjectiveCorrectCount`、`verificationObjectiveCorrectRate`、`masteryAssessmentBreakdown`。分母一律**排除 `unreliable`**（理由见 §0.2 ③：`skipQuizTurn` 也写 `unreliable`，混了"模型判不了"与"用户跳过"两种语义）。
3. **`evidenceStatus` 的语义不动**（保持 `sampleCount >= 3`），**另加**一个独立的 `objectiveEvidenceStatus`（`objectiveAnswerCount >= 3`）。
   **为什么必须拆开**：`evidenceStatus` 是**主数字**的可用性门槛。若把客观门槛挂上去，"有自评但客观样本少"的块会把主数字从 usable 降级为 insufficient —— 那是用户可见的行为变化，**与 D-1(b) 直接冲突**。
   **佐证（已核实）**：`evidenceStatus` 目前**没有任何 UI 消费者** —— `domain.ts:353`（类型）、`replay.ts:238`（计算）、`reviewCoachSchema.ts:62`（索引）即为全部。所以拆成两个字段不会引起界面回归。
4. **界面主卡片不动。** `ReviewCoachWorkbench.tsx:273-289` 现有文案本身就写着"用户自评保持率 N%（X/Y）"与"验证样本较少：用户自评保持 X / Y"，**已经明示这是自评**。本轮不加也不改这一处。
5. **B-2 回流送客观指标，不送 `retentionRate`。** 这是本决策下最关键的一处设计：`planSession` 的 `interventionEffects` 只暴露 `objectiveCorrectRate` / `verificationObjectiveCorrectRate` / `objectiveUnreliableCount` / `strategyKey`（**不含**自评保持率），门槛用 `objectiveEvidenceStatus === "usable"`。否则等于让模型去学习用户的**主观感觉**。
6. **对 §0.1 的一处自我更正（重要）。**
   我在 §0.1 写过"选 (b) 意味着 B 只能回流主观数据"。**这句话不准确，予以更正。** 「B-2 回流用什么指标」与「界面显示什么」是两件独立的事；选 (b) 之后**仍然可以把客观指标送进规划**。所以 (b) 的真实代价不是"系统内部无法回答是否真的学会"（内部仍然能回答），而是：
   > **用户自己看不到"自评 vs 客观"的差距** —— "我该怀疑自己的记忆感觉"这个元认知信号不会传达给用户，只能被系统内部用来换教法。
   这个代价可以接受，而且**极易回退**：将来只要在 `ReviewCoachWorkbench` 那个卡片上加一行字就能开始展示，数据那时已经在库里。
7. **本轮明确不做**：把自评冲突拦截从"仅 `incorrect`"扩展到 `partial` / `unreliable`（`orchestrator.ts:823`、`:857`）。理由：那会增加用户点"已掌握"时的摩擦，属产品交互决策；在 D-1 选 (b)「尽量不改用户可见行为」的基调下不宜顺带收紧。**保留在 §9.6 待议清单。**

### 9.3 批次 A：让效果可度量

**A-1（F-18）把原始材料交给答案评估器**

| 位置 | 改动 |
| --- | --- |
| `src/hooks/useAppData.ts` | `submitAdaptiveQuizAnswer` 取 `task` + `record`，用 `buildDecisionBlockAiContextPack(...).markdown` 构造材料传入 orchestrator（照 `generateAdaptiveQuizTurn` 的写法） |
| `orchestrator.ts:774` | `evaluateAnswer` 的 input 增加 `decisionBlockContent`（字段名与 `:696` 一致） |
| `quizExecutionGateway.ts:61-68` | 指令增加"判据由出题者提供，可能不完整或不准确；必须同时对照 `decisionBlockContent`；若判据与材料冲突，或材料不足以覆盖该判据，`assessment` 必须为 `unreliable` 并在 `rationale` 说明"；`maxTokens` 1000 → 1400 |
| 前置 | 抽出 `assertTurnContextBudget(provider, markdown)`（与批D-2 同一函数，本批先落地） |
| 版本 | `ANSWER_EVALUATION_PROMPT_VERSION` → `answer-evaluation-v2` |
| 测试 | `quizExecutionGateway.test.ts`：断言 input 含材料、指令文本含冲突条款；新增"判据与材料冲突 → `unreliable`"用例 |
| ⚠️ | **改变模型所见指令，触发 §9.7 阶段二的付费验收** |

**A-2（F-02）效果摘要同时输出客观与自评两组指标（不合并）**

| 位置 | 改动 |
| --- | --- |
| `domain.ts` | `InterventionEffectSummary` 增加 §9.2 第 2 条的 10 个字段 + `objectiveEvidenceStatus`；`immediateMasteredCount` 重命名为 `selfReportedMasteredCount` 并**保留旧名别名** |
| `replay.ts` | 在既有 `groups` 循环内聚合；`REVIEW_COACH_REPLAY_VERSION` → `review-coach-replay-v3`；**`evidenceStatus` 一行不改** |
| `ReviewCoachWorkbench.tsx` | **不改**（§9.2 第 4 条） |
| 测试 | 新增 `replay.effectMetrics.test.ts`（4 条：客观率 1/3、无作答事件时 `objectiveEvidenceStatus === "insufficient"`、自评与客观在冲突数据下不等、`unreliable` 不进分母）；`repository.test.ts:543-545` 改为 `objectContaining` |

**A-3（F-14）效果归因到实际题型与提示维度**

| 位置 | 改动 |
| --- | --- |
| `replay.ts:179` | `strategyKey` 追加 `actualPracticeType`（该任务出现次数最多的 `AdaptiveQuizTurn.practiceType`）与 `hintLevelUsed`（`none` / `hint-only` / `explain-or-worked-example`） |
| `replay.ts:202` | `averageTurnsToMastery` 排除 `[skipped]` 轮 |
| 测试 | 新增 `replay.strategyKey.test.ts`：同 `problemType` 下"变式题+无提示"与"概念题+用提示"产出两条独立键 |

### 9.4 批次 B：让结论能回流

**B-1（F-08）投影优先级改为显式裁决**

`replay.ts:62-134`：改为「任务在跑 → 新反馈 → 结果事件」的显式优先级，`lastContentEventAt` / `lastFeedbackAt` 明确化。
测试：新增 `replay.projection.test.ts`。**既有 `repository.test.ts:470/499/542` 不改**（已核对 fixtures 时间戳：feedback `08:00` < 结果 `10:00`，结果仍胜出）。

**B-2（F-01）效果摘要作为深度规划的只读输入**

| 位置 | 改动 |
| --- | --- |
| `sessionPlanningGateway.ts:29-50` | 输入增加 `interventionEffects`：**只含客观指标（§9.2 第 5 条）**，`objectiveEvidenceStatus === "usable"`，按 `strategyKey` 去重、上限 5 条 |
| 同文件提示词 | 增加定位段："这些是该用户的历史干预效果，仅用于在**同一学习目标内部**选择训练方式与难度；不得据此改变主决策块、不得据此宣告掌握、样本不足时必须忽略" |
| `orchestrator.ts:452` | `analyzeFeedback` 复用既有 `existingSnapshot` 算一次效果摘要（在子批次循环外，只算一次） |
| `analysisPlanner.ts` | `inputFingerprint` 混入 `strategyKey + replayFingerprint`（既有不可变冻结字段，零同步变更） |
| 测试 | `sessionPlanningGateway.test.ts` +4 条，其中**必须有一条断言 input 里不含 `retentionRate`** |

**B-3（F-03）让"衰退"回到重新规划（按 D-2 的 (b)）**

`orchestrator.ts:850-869`：`decayed` 之后在工作台显示"该重点出现衰退，建议补充说明"，并给一键入口（写一条 `source: "manual"`、`includeInAnalysis: true` 的反馈）。**不创建系统代笔的 `DecisionBlockFeedback`。**
测试：断言提示出现、一键入口产生 `source: "manual"` 反馈、`decisionBlockState` 不因系统动作被改写。

### 9.5 批次 C：拿到练习 + 证据不被污染

**C-1（F-17）角色级 System Prompt**

按 `docs/handoff-f17-coach-role-system-prompt-2026-09-14.md` 执行。要点：`SYSTEM_PROMPT` → `CHAT_SYSTEM_PROMPT`（文本一字不改）；`AiCompletionRequestOptions.systemPrompt?`；`buildAiMessages(..., systemPrompt?)` **末位可选**；`sendChatCompletionDetailed` 透传；`sendChatCompletion` **不传**；新增 `reviewCoach/rolePrompts.ts`；3 个网关接线。
**必须加的断言**：`request.systemPrompt` 不出现在 HTTP body（`aiClientService.ts:382` 显式挑字段，`...options.request` 在 `:571` 展开）。
版本：`session-blueprint` / `quiz-turn` / `question-quality` 随指令环境变更一并 bump。

**C-1b（F-21，范围外同根因）知识播客**

`aiClientService.ts:245` 那句"回答要求……结尾写依据来源"**参数化**（新增可选 `attachmentAnswerInstruction`，传 `null` 即抑制）；`knowledgePodcastService.ts:542` 传自己的 role prompt 与 `attachmentAnswerInstruction: null`。
**普通问答不传 → 行为完全不变。** 测试需同时断言播客被抑制、普通问答仍含该句。

**C-2（F-04 + F-07）出题提示词与 schema 同源**

`quizExecutionGateway.ts:47` 的 `practiceType` 枚举改为由 `aiSchemas.ts` 的 `practiceTypes` **同源生成**（禁止再手写）；`orchestrator.ts:706` 拆开 `requestedStrategy` 与 `initialPracticeType`。
测试：断言提示词中的枚举与 `practiceTypes` **逐字一致**（防止再次漂移）。

**C-3（F-06）给 `unreliable` 明确分支语义（**2026-09-14 修订，原"降级为 partial"方案作废**）**

原方案"本地降级按 `partial` 分支"**错误**：`unreliable` 混合了"模型判不了"与"用户跳过"（`orchestrator.ts:797`），把它当答错会污染掌握判定与策略。改为三条独立约束：

1. **不进作答命中率的分子或分母**（A-2 已落地）。
2. **不自动升高或降低难度**，也不自动进入/退出"掌握"判定。
3. **触发一次"再验证"而非"改策略"**：先让模型在更完整的材料下重判一次（A-1 之后材料已具备）；重判仍为 `unreliable` 时，向用户提示"这道题暂时无法可靠判定"，该轮标为不可评估，**不写任何策略决策**。

`domain.ts:172` 的 `BlueprintBranch.when` 是否新增 `unreliable` 分支，取决于第 3 条落地后是否仍需本地分支；若不再需要则**不新增**，保持分支表最小。`orchestrator.ts:688-689` 的静默 `continue` 必须改为显式处理（不再是静默丢弃）。

**C-4（F-20）本地答案泄漏检查**

新增 `src/features/reviewCoach/questionIntegrity.ts`：题干与 `hints` 不得包含 `answerCriteria` 的规范化子串（本地，零模型调用）；`aiSchemas.ts:250` 的 `severeIssues` 枚举增加 `answer-leakage`；开放题也纳入质检。

**C-5（F-19）跨块门禁真正生效**

`orchestrator.ts:177-194`：校验基准从"全批并集"改为**按主块集合**；`allowCrossBlockSupport = false` 时辅助块引用一律拒绝。

### 9.6 待议清单（本轮记录但不做）

| 项 | 为什么不本轮做 |
| --- | --- |
| 自评冲突拦截扩展到 `partial` / `unreliable`（`orchestrator.ts:823,857`） | 会增加用户点"已掌握"的摩擦，属产品交互决策；与 D-1 选 (b) 的基调不符 |
| 在 `ReviewCoachWorkbench` 展示客观指标 | D-1 已选 (b)。**将来只需加一行字即可开启**，数据那时已经在库里 |
| F-16 补更多维度 | A-2 / A-3 已覆盖主要维度，其余等真实样本积累 |
| 批D-1…批D-5、F-10 / F-12 / F-13 | 等 A/B/C 真实数据出来后再排 |

### 9.7 统一验收方案（对应"全部做完统一验收"）

**阶段一：自动测试**（每批完成即跑；最终统一跑一次全量）

1. `npx vitest run src/features/reviewCoach`（基线 17 文件 / 94 项 → 预计 19–20 文件）
2. `npx vitest run src/services/aiClientService.test.ts src/services/knowledgePodcastService.test.ts`
3. `npm run test`（全量）
4. `npm run build`
5. 本轮**不涉及界面改动**，Playwright 预计可跳过；由实现方判定并在记录里写明理由

**阶段二：一次付费受控真实 Provider 验收（已授权）**

- 覆盖：A-1 与 C-1 / C-1b 的提示词改动
- 最小样本：**1 个决策块** → 评论整理 ×1 + 会话规划 ×1 + 逐轮出题 ×3 + 题目质检 ×3 + 答案评估 ×3 ≈ **11 次调用**
- 记录指标：**解析成功率 / `AiSchemaError` 次数 / 重试次数 / `unreliable` 占比**；并**人工复核 5 条判题**（对照材料，判断判据错误能否被正确反驳）
- 输出：`docs/ai-cockpit-remediation-acceptance-2026-09-14.md`
- **如实报告原则**：若改动前后失败率都接近 0，必须写明本项价值在"消除不确定性"而非"减少报错次数"，不得为了证明改动有效而夸大

**阶段三：交付清单**

1. 上述验收记录
2. `AGENTS.md` 的 Current Baseline 补一条事实描述（本项已完成；既有发布门槛不变）
3. 一张"变更了什么 → 客观指标怎么变了 → 是否触发真实 Provider 验收"的汇总表

**回滚总则**：A/B 批回滚后 `replayVersion` 不匹配会触发一次投影重建，**无数据风险**；C 批为提示词与本地校验类改动，回滚即恢复旧行为。**全轮不改 schema 与同步契约，因此不存在需要回滚数据的情形。**

### 9.8 版本号 bump 需要连带处理的位置（已核实）

**确定必改**：

- `aiSchemas.ts:10-14` —— 版本常量本体
- `sessionPlanningGateway.ts:42` —— 版本号被**硬编码在提示词文本里**（"……必须严格符合 session-blueprint-v1 JSON Schema……"）
- `aiSchemas.test.ts:15` —— 条件断言 `contract.promptVersion === "quiz-turn-v2" ? /-v2$/ : /-v1$/`，bump 后条件为假会直接失败

**需逐一判定**（bump 后跑测试即可暴露，不预先假定都要改）：

`orchestrator.test.ts:28,52`、`reviewCoachTestFixtures.ts:63,103,149`、`sessionPlanningGateway.test.ts:26`、`cloudSyncModel.test.ts:136`、`stage3PreviewSeed.ts:186,311`。

判定原则：**测试数据里的版本号可以改**（它们只是构造样本）；**断言里的版本号只有在断言的是"版本号被正确记录"时才改**，若断言的是业务语义则不能动。
