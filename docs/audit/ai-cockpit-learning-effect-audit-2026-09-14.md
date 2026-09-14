# AI 驾驶舱（Review Coach）审计报告

> 审计日期：2026-09-14
> 审计范围：`src/features/reviewCoach/**`、`src/features/reviewSession/**`、驾驶舱相关的 `src/hooks/useAppData.ts` 接线、`src/services/storageAdapter.ts` 的复习提交/撤回、`src/lib/learningStats.ts`
> 明确排除：语音复述（`src/features/voiceRecall/**`）及其提示词
> 审计性质：**只读审计，未修改任何代码、测试、配置或数据**
> 依据基线：`docs/新的方案.md`（产品边界）、`AGENTS.md`（工程基线）

---

## 0. 一句话结论

驾驶舱在**"记录学习过程"和"生成练习"这两层是可信的**，但在**"度量学习效果"和"用效果改变教学"这两层基本是空的**：

- 效果指标（即时已掌握率、延迟保持率）**全部由用户自评构成**，已经采集到手的 AI 客观判题结果不参与统计；
- 效果摘要**只用于界面展示**，不进入深度规划器的输入，所以历史效果不会影响下一次教学策略；
- Blueprint 里的大多数教学约束（难度、分支策略、禁止范围、回合重试、费用上限）**只写给模型看，本地不做校验**；
- 判为"衰退"的决策块**不会自动回到重新规划**，闭环在最后一环断掉。

因此：**目前这套系统还没有客观证据证明它带来了学习效果，而且它自身的数据结构也不足以回答这个问题。**下文第 3 节给出这个判断的完整证据链。

---

## 1. 审计方法

逐层阅读并交叉核对下列链路（未运行真实 Provider，未做任何写操作）：

```
复习卡提交评论 → 队列项 → 快速模型结构化理解 → 首页工作台确认 → 深度模型 SessionBlueprint
   → 本地调度（唯一当前任务/等待/延期/失效）→ 快速模型逐轮出题 + 质检
   → 用户作答 → AI 判题 → 三档自评 → 延迟验证计划 → 延迟验证任务 → 保持/衰退
   → DecisionBlockState / InterventionEffectSummary（投影）→ 再回到规划？
```

核对方式：以"产品文档要求"对照"实际代码行为"逐条对照；对每个可疑点定位到文件与行号；对"是否存在使用方"的问题用全仓引用检索验证（不使用猜测）。

---

## 2. 发现清单（按严重度）

| 编号 | 严重度 | 结论 | 关键位置 |
| --- | --- | --- | --- |
| F-01 | **P0** | 效果学习闭环未闭合：`InterventionEffectSummary` 不进入规划输入，"历史效果影响下一次教学"未实现 | `replay.ts:161-245`、`sessionPlanningGateway.ts:34-50`、`orchestrator.ts:475-502`、`ReviewCoachWorkbench.tsx:86-94,273-289` |
| F-02 | **P0** | 效果指标 100% 来自用户自评，AI 客观判题结果完全不参与聚合 | `replay.ts:194,210-212`、`orchestrator.ts:850-869` |
| F-03 | P1 | 延迟验证"衰退"不触发重新规划，"decay 重新入队"未实现 | `orchestrator.ts:843-845` vs `850-869`；`domain.ts:93` 定义未使用 |
| F-04 | P1 | 出题提示词的 `practiceType` 枚举与本地 Schema 不一致，会直接判失败并计费 | `quizExecutionGateway.ts:47` vs `aiSchemas.ts:127-135`；`aiClientService.ts:387,52-54` |
| F-05 | P1 | Blueprint 的难度/费用/重试/禁止范围/策略分支只在提示层生效，本地零校验 | `orchestrator.ts:595-607,706`；全仓检索仅见"写入"，无"读取" |
| F-06 | P1 | `unreliable`（无法可靠判定）没有分支策略，静默退化为 `continue` | `domain.ts:172,238`、`orchestrator.ts:688-689,706` |
| F-07 | P1 | 首轮把 `practiceType` 塞进 `requestedStrategy` 字段，语义混用 | `orchestrator.ts:706` |
| F-08 | P1 | 决策块状态投影会被更早的结果事件覆盖（新反馈被旧"已掌握"盖掉） | `replay.ts:78-101` |
| F-09 | P2 | 修改决策块会静默废弃该块的待分析项/蓝图/未完成任务，界面无提示 | `repository.ts:479-494`、`analysisPlanner.ts:65-75` |
| F-10 | P2 | "深度模型/快速模型分离"只体现在提示词，从未体现在模型选择；`AiRoleConfig` 无配置入口 | `useAppData.ts:424-445,516-541`、`domain.ts:367-378` |
| F-11 | P2 | 出题路径没有上下文 token 预算校验（分析路径有） | `useAppData.ts:555-573` vs `analysisPlanner.ts:45-46,130` |
| F-12 | P2 | 投影表写放大严重且几乎无人读取；解释保存不触发重放 | `repository.ts:411-435` 及 18 处调用点；`repository.ts:727-742` |
| F-13 | P2 | 用户报告"题目有问题"不触发质检、不补题 | `orchestrator.ts:802-815` |
| F-14 | P3 | 效果摘要未按"实际题型/辅助策略"分桶，无法回答"哪种教法有效" | `replay.ts:179,202,231` |
| F-15 | P3 | 延期任务会无限期推迟该块的延迟验证入队；验证任务复用原 `maxTurns` | `orchestrator.ts:908-914`、`repository.ts:1154`、`orchestrator.ts:678` |
| F-17 | P1 | **（第二轮补入）** 驾驶舱 5 个 AI 角色全部继承普通问答的全局 System Prompt，与"只输出 JSON"直接冲突 | `aiClientService.ts:64-69,224,569` |
| F-18 | P1 | **（第二轮补入）** 答案评估器看不到原始材料，只按出题模型自写的判据评分 | `orchestrator.ts:774`（对比 `696,722` 均传 `decisionBlockContent`） |
| F-19 | P1 | **（第二轮补入）** 关闭跨块支持时，其他块的反馈/解释/证据仍可进入 Blueprint | `orchestrator.ts:177-194`（门禁只在 `173-176`） |
| F-20 | P2 | **（第二轮补入）** 没有答案泄漏检测；唯一相关文本是提示词指令，测试只覆盖 UI 渲染 | `quizExecutionGateway.ts:46`、`AdaptiveReviewPage.test.tsx:34-42` |
| F-21 | P2 | **（第三轮补入，范围外同根因）** 知识播客与驾驶舱共享同一根因但冲突更严重：它要求"输出纯 JSON，不要 Markdown 代码围栏"，却同时传 `attachment`，于是额外收到一条 system 消息要求"在回答末尾写'依据来源：[[S1]]…'"，加上全局 System Prompt 的"Markdown + 结尾列来源"，共三条互相否定的指令。**不属 AI 驾驶舱范围**，但证明这是传输层共性缺陷而非驾驶舱个例 | `knowledgePodcastService.ts:408,411,542`、`aiClientService.ts:64-69,245`；重试旁证 `knowledgePodcastService.ts:535` |

> F-21 的立场说明：本次审计范围是 AI 驾驶舱，播客不在范围内，**不计入驾驶舱的 20 条发现**。之所以记录，是因为它与 F-17 同根因，说明"全局 System Prompt 无条件注入 + 各功能自行写格式要求"是**传输层设计缺陷**；若只修驾驶舱，同一类故障仍会在播客上复现。

---

## 3. 核心问题：到底有没有真正的学习效果？

分三层回答，结论不同。

### 3.1 记录层：有，而且做得相当扎实

客观证据确实被完整采集并结构化：

- 每轮题目、答案、AI 判定（`correct|partial|incorrect|unreliable`）、判定理由都落库为正式事实（`TaskOutcomeEvent.kind = "answer-assessment"`，`orchestrator.ts:781-786`）；
- 提示使用按级别记录（`recordQuizHint`，`repository.ts:1028-1040`）；跳过的轮次会用 `[skipped]` 与 `unreliable` 显式标记，并且不计入有效作答（`orchestrator.ts:820,854`）；
- 主观自评、即时表现、执行处置（完成/延期/放弃/题目无效）四类结果分开保存（`domain.ts:271-284`、`validation.ts:84-98`），"没时间""题目有错"不会被压成"未掌握"——这一条与文档要求一致；
- 作答前不泄露答案与来源，提交后才展示来源片段（`AdaptiveReviewPage.tsx:190-234`）。

**这一层没有问题，是后续判断的基础。**

### 3.2 度量层：部分失真——效果指标只有自评，没有客观值

**F-02**：`InterventionEffectSummary` 的两个关键分子都来自"用户点了什么"，而不是"答得对不对"：

- `immediateMasteredCount` = 自评 `mastered` 的条数（`replay.ts:194`）；
- `delayedRetainedCount` / `delayedDecayedCount` = 用户在验证页点"仍然掌握/已经衰退"的结果（`replay.ts:210-212`，来源 `orchestrator.ts:850-869`）。

`turn.assessment`（AI 判题）与 `answer-assessment` 事件**在整个 `replay.ts` 里没有任何聚合点**——它们只被用来做分支选择和历史上下文，从未进入任何效果统计。

后果很具体：

1. 一个用户若习惯性点"已掌握"，即使最后一轮被判 `incorrect`（现有实现只要求二次确认，不阻止记录，`orchestrator.ts:823`），`immediateMasteredCount` 照样 +1；
2. **更宽的口子（第二轮补强）**：冲突拦截只针对 `incorrect`。最后一轮被判 `partial`（部分正确）或 `unreliable`（无法可靠判定）时，`mastered` / `retained` **连二次确认都不需要**（`orchestrator.ts:823`、`857`），可以直接写入 `improved-pending-verification`（`replay.ts:90`）或 `retained`（`replay.ts:97`），并直接进入保持率分子；
3. 界面上的"用户自评保持率"（`ReviewCoachWorkbench.tsx:284`）措辞是诚实的，但它是这个系统里**唯一**的效果数字，会被读成"学习效果"；
4. 客观判题已经存好了，**只差一次聚合**——这是本次审计中"性价比最高的修复点"。

**建议（未实施）**：摘要同时输出两条独立指标，禁止合并：
- 客观提取表现：`answer-assessment` 中 `correct / (correct+partial+incorrect)`，以及验证轮的客观答对率；
- 主观自评：现有的 `mastered` 计数与自评保持率。
并把 `evidenceStatus: "usable"` 的门槛改为"客观样本 ≥ 3 且主观样本 ≥ 3"，两者不足时都显示"证据不足"。

### 3.3 反馈层：没有——效果不回流，闭环最后一环缺失

**F-01** 是最严重的一条。产品文档第 12 节明确要求"以不同教学干预在当前用户身上的实际效果作为下一次规划输入"，第 1 节的闭环图也以"历史效果反过来影响下一次教学策略"收尾。实际实现是：

- `replayInterventionEffectSummaries` 的调用方只有两个：`ReviewCoachWorkbench.tsx:86-94`（界面展示前 3 条）和 `repository.ts:417,1317`（重建投影 / 校验投影）；
- 深度规划的输入只有两个字段：`blocks` 和 `allowedSupportingDecisionBlockIds`（`sessionPlanningGateway.ts:29-50`）；
- `orchestrator.planSession` 的调用点（`orchestrator.ts:475-502`）没有传入任何效果摘要。

也就是说：**系统能显示"某类训练保持率偏低"，但这个结论不会改变它下次给什么题、用什么策略。** 加上 F-05（策略不被本地校验），"自适应"目前的真实含义是"深度模型一次性写蓝图 + 快速模型自由发挥"，而不是"系统从效果中学习"。

与之配套的另一半也缺失（**F-03**）：训练结束后"未掌握"会写一条新反馈并进入待分析队列（`orchestrator.ts:843-845`），但延迟验证判为 `decayed` 时**什么都不做**（`850-869`），只把投影写成 `needs-consolidation`。`AnalysisEligibilityReason` 里声明的 `delayed-verification-decay` 与 `replan-after-failure` 在全仓没有任何使用点（仅 `domain.ts:90-94` 定义）。所以"我确实忘了"这件事不会自动带来重新教学。

**结论**：系统当前回答不了"有没有真正的学习效果"。它既没有用客观证据去度量效果，也没有把度量结果用于改进教学。要得到答案，只能靠外部手段（人工对照、A/B、或学生前后测），而现有数据模型已经具备支撑这类分析的全部原始事实。

---

## 4. 逻辑不符 / 输出与预期不一致

### F-04（P1）出题提示词的枚举和本地 Schema 对不上——确定性失败源

`quizExecutionGateway.ts:47` 指示模型：

```
"practiceType":"concept|calculation|discrimination|cloze|variation|chunk"
```

而本地合法枚举（`aiSchemas.ts:127-135`）是：

```
concept-question | calculation | distinction | cloze | variation | chunk-training | prerequisite-check
```

对照结果：指令里的 `concept`、`discrimination`、`chunk` **三者非法**；`prerequisite-check` 从未被提及。

为什么这是真问题而不是"模型会自己纠正"：

1. `structuredOutput: true` 在传输层**只发送 `response_format: { type: "json_object" }`，不发送 enum 约束**（`aiClientService.ts:387`）。提示词文本是模型获知取值的唯一来源。
2. 校验是严格的：`parseQuizTurnAiResponse`（`aiSchemas.ts:387`）→ `isPracticeType`，不合法直接抛错。
3. 抛出的 `AiSchemaError` 是 `retryable = false`（`aiClientService.ts:52-54`），而 `orchestrator.ts:692-709` 的两次尝试循环**没有 try/catch**，异常直接穿透到 UI。
4. 现有测试（`quizExecutionGateway.test.ts`）只断言提示里包含 `"answerCriteria":["..."]`，**没有断言枚举文本**，所以 CI 不会拦住它。

后果：用户在"开始训练/继续下一轮"时看到格式错误，点一次重试就多计费一次；由于提示词是固定的，同一个模型可能每次落在同一个非法值上。

**修复方向**：提示文本由 `practiceTypes` 常量拼接生成（单一真源），并补一条"提示中的取值集合 === schema 枚举"的测试。

### F-06（P1）`unreliable` 无分支，静默推进

`ImmediateAnswerAssessment` 有四种值（`domain.ts:238`），但 `BlueprintBranch.when` 只有 `correct|partial|incorrect|skipped`（`domain.ts:172`）。当 AI 判 `unreliable` 时：

```ts
const previousBranch = previous?.answerText === "[skipped]" ? "skipped" : previous?.assessment;
const branch = previousBranch ? blueprint.branches.find((item) => item.when === previousBranch) : undefined;   // → undefined
requestedStrategy: ... branch?.nextStrategy ?? (turns.length === 0 ? ... : "continue")                        // → "continue"
```

（`orchestrator.ts:688-689,706`）

判题不确定恰恰是最需要追问或降难度的时候，却被当成"继续"。同时 `verificationPolicy.ts:33` 又把 `unreliable` 和 `partial` 归为同一类处理，两处语义不一致。

### F-07（P1）`requestedStrategy` 被塞入题型

`orchestrator.ts:706` 在首轮传 `blueprint.initialPracticeType`（如 `"concept-question"`）给名为 `requestedStrategy` 的字段，而该字段的语义域是 `continue|hint|explain|worked-example|prerequisite-check|finish`。模型收到的是一条自相矛盾的指令。与 F-04 同源，应拆成两个字段（`initialPracticeType` 与 `requestedStrategy`）。

### F-05（P1）Blueprint 约束只在提示词里生效

| 字段 | 写入位置 | 本地读取/校验 |
| --- | --- | --- |
| `initialDifficulty` | `orchestrator.ts:599` | 无 |
| `maxEstimatedTokens` | `orchestrator.ts:607` | 无（无按任务费用熔断） |
| `maxRetriesPerTurn` | `orchestrator.ts:606` | 无（出题重生成次数硬编码为 2，`orchestrator.ts:692`） |
| `forbiddenScope` | `orchestrator.ts:603` | 无 |
| `expectedKeyPoints` | `orchestrator.ts:600` | 无（判题只用 `answerCriteria`） |
| `hypothesisConfidence` | `orchestrator.ts:595` | 无 |
| `branches[].nextStrategy` | `orchestrator.ts:601` | 仅作为字符串传给模型；返回体里**没有策略字段**，无法校验模型是否遵循 |
| `allowedStrategies` | `orchestrator.ts:602` | 只校验它是白名单子集（`validation.ts:100-112`），不校验实际使用 |

也就是说"快速模型不能擅自改 Blueprint"这条约束，在**目标/来源/版本**维度是靠哈希严格校验的（做得很好），但在**教学策略**维度只靠提示词自律。文档第 8.1 节列举的轮次策略（概念问答、计算、辨析、变式、Chunk 训练、前置检查）无法被验证是否真的被执行。

### F-08（P1）状态投影会被旧结果覆盖

`replay.ts:78-101` 的算法是"先按事实算基线，再把所有结果事件按时间顺序 apply，最后写入者胜"：

```ts
let status = "unassessed";
if (activeFeedback.length > 0) status = "needs-analysis";        // ① 有新反馈
if (blueprints.length > 0 || ...) status = "planned";
if (currentTask) status = "learning";
for (const event of statusEvents) event.apply();                 // ② 旧事件覆盖 ①
```

场景：T1 本轮训练自评"已掌握" → `improved-pending-verification`；T2 用户又写下新的困惑 → 投影仍是 `improved-pending-verification`，与"存在待分析反馈"直接矛盾。文档 10.1 要求投影是"由这些事实计算出的当前投影"，这里缺少"反馈时间 vs 结果时间"的先后裁决。

当前主路径用 `analysisPlanningBlocks`（走队列项）绕过了这个投影，所以线上暂时看不出来；但 `repository.test.ts:470,499` 恰好把这个行为断言成了期望值，**修复时需要同步改测试**，否则未来任何读投影的功能都会拿到错误结论。

---

## 5. 潜在 bug 与健壮性风险

### F-09（P2）编辑决策块会静默掐断闭环

`staleDerivedWork`（`repository.ts:479-494`）在 `contentVersion` 递增时，会把该块所有 `eligible/excluded/batched` 队列项、`accepted` 蓝图、开放任务、未完成验证一次性置为 `stale`。同时 `buildAnalysisPlanningBlocks`（`analysisPlanner.ts:65-75`）只接受 `eligible` 项且要求 `contentVersion` 完全相等。

后果：用户修正块里一个错别字 → 之前写下的困惑、已生成的蓝图和任务全部失效，界面表现为"该条目从工作台消失"，没有任何提示说"你需要重新反思"。这属于**用户感知不到的学习闭环断裂**。

**建议**：块版本变化后，在复习卡和工作台显式提示"该重点已更新，历史评论/分析已失效"，并提供"带着旧评论重新发起分析"的一键入口。

### F-10（P2）双层 AI 只分提示，不分模型

`executeDeepAnalysis` 与 `createQuizOrchestrator` 都用 `getCurrentAiProvider(currentSettings.ai)` 取同一个 Provider，然后把同一个 `provider.id`/`model` 写回角色配置（`useAppData.ts:424-445,516-541`）。`AiRoleConfig` 有完整的 `providerId/model/timeoutMs/maxRetries/maxConcurrency`（`domain.ts:367-378`），但**全仓没有任何配置入口**，只有 `useAppData` 的自动写回。

三个后果：
1. 与文档 7.1 的"高成本模型负责复杂教学决策，低成本模型负责高频执行"不符，成本无法按角色分层；
2. "题目质检"（`reviewQuestion`）用的是**和出题同一个模型**，等于自审，防御能力有限（文档 8.3 允许，但未利用）；
3. `maxRetries` 字段实际未被读取（各调用点用硬编码或调用方参数），配置存在"写着但无效"的问题。

### F-11（P2）出题路径缺少上下文预算

分析路径有完整预算：`maxAnalysisInputTokensForProvider` + `oversized` 拒绝（`analysisPlanner.ts:45-46,130`，`orchestrator.ts:433`）。出题路径直接把整块 markdown 全量塞进 prompt（`useAppData.ts:559-566`），没有任何 token 估算或拒绝。超大块会在分析阶段被挡，却能在出题阶段把请求撑爆——报错时费用已经产生。

### F-12（P2）投影写放大 + 读取方缺失

`rebuildReviewCoachProjectionsInTransaction`（`repository.ts:411-435`）在执行时会**全表读取所有 Coach 事实 → 校验 → 对所有决策块重放 → 全表清空重写**，而它被挂在了几乎所有写路径上（可见于 `repository.ts:525,566,666,692,707,760,795,857,884,910,948,988,1061,1090,1176,1213,1249,1287` 等 18 处）。复杂度是 O(块数 × 事实数) 的全量重算，随数据量增长，每次复习评分、写评论都会变慢（且在 IndexedDB 事务内）。

同时：

- `decisionBlockStates` 表除了 repository 自身和测试，**没有任何读取方**；
- `interventionEffectSummaries` 表同样无人读取——工作台是现场用 `replayInterventionEffectSummaries` 现算的（`ReviewCoachWorkbench.tsx:86-94`）；
- `saveFeedbackInterpretation`（`repository.ts:727-742`）**不触发重放**，而 `areProjectionsCurrent()` 只在 App 启动时检查一次（`useAppData.ts:189`），因此投影与正式事实在运行期间可能持续不一致。

**建议**：要么把投影做成惰性/增量（只重算受影响的块），要么承认这两张表是"启动期校验缓存"并去掉高频写路径上的重算。

### F-13（P2）报错入口不产生补救动作

`reportInvalidQuestion`（`orchestrator.ts:802-815`）只做两件事：把该轮标记 `invalid`、把整个任务标记 `invalid`。文档 10.3 要求"题目错误或严重偏题 → 任务标记为无效并**触发质检**"，这里的质检/重生成未实现。而且一次坏题会终结整个会话，已完成的轮次只能作为历史保留，用户需要重新发起分析才能再练。

### F-15（P3）验证窗口可能被无限推后

`refreshDueVerifications` 用 `openTargets` 排除"同一块版本已有开放任务"的验证（`orchestrator.ts:908-914`），而 `deferred` 属于开放状态（`repository.ts:1154` 保留 `openTargetKey`）。用户对某块点一次"稍后再做"，该块到期的延迟验证就无法物化成任务，直到原任务结束。由于延迟验证是这套系统里唯一的长期保持证据，这条会让"是否真的记住"长期无法被检验。

另外，验证任务复用原 Blueprint 并**独立计数** `turns.length`（`orchestrator.ts:678`），等于给一次"换个新题检查一下"的验证会话开放全部 `maxTurns`（最多 20 轮），语义偏松。

### F-16（P3）效果摘要的统计粒度不足

`strategyKey` = `problemType : initialPracticeType : provider : model : promptVersion : policyVersion`（`replay.ts:179`）。它**不含实际使用的教学策略**（`continue/hint/explain/worked-example/prerequisite-check`），也不含每一轮的真实题型（只用蓝图里的初始题型），`averageTurnsToMastery` 还把 skipped 轮计入轮数（`replay.ts:202`）。因此文档 12 节要求的"讲解、例题、变式、Chunk 训练和前置检查后的结果对比"无法从摘要中得到——这恰好是 F-01 想回流到规划时最需要的输入。

---

## 6. 优化建议（按优先级）

**第一优先（直接决定"能不能回答学习效果"）**

1. 聚合客观判题结果：在 `replayInterventionEffectSummaries` 中增加 `objectiveCorrectCount / objectiveSampleCount`，与自评指标并列且不合并，界面同时展示（F-02）。
2. 把效果摘要接入 `planSession`：以"样本 ≥ 3、按策略隔离"为门槛作为只读输入传给深度模型，并让蓝图记录"采用了哪条历史结论"（F-01）。
3. `decayed` 与 `not-achieved` 统一走重新规划：写入 `source: "manual"` + `eligibilityReason: "delayed-verification-decay"` 的反馈并进入队列（F-03）。

**第二优先（确定性与可靠性）**

4. 提示词枚举从常量生成 + 加一致性测试（F-04），拆分 `requestedStrategy` / `initialPracticeType`（F-07）。
5. 给 `unreliable` 定义明确策略（追问 / 降难度 / 换题型），或在 schema 上把 `unreliable` 显式映射到某条分支（F-06）。
6. 在返回体中加入模型实际选择的策略字段，并由本地校验它是否落在 `allowedStrategies` 内（F-05）。
7. 块版本变化后给出可操作的用户提示与"带走旧评论重新分析"入口（F-09）。
8. 出题路径补 token 预算校验与按任务费用熔断（F-11）。
9. **（第二轮补入）** 为驾驶舱各角色传入角色级 system prompt，移除"Markdown/LaTeX/结尾列来源"与 JSON-only 的冲突（F-17）；建议同时对 F-04 与 F-17 的修复各自补一条断言，因为这两条是当前**唯二**已定位的确定性失败源。
10. **（第二轮补入）** 把原始材料一并传给答案评估器，让判据错误不再被自洽继承（F-18）；并把"答案泄漏"纳入质检的严重问题枚举，至少覆盖 `open` 题型（F-20）。
11. **（第二轮补入）** 跨块引用的校验基准从"全批并集"改为主块集合（`allowCrossBlockSupport=false` 时），或要求用户显式确认被引用的辅助块（F-19）。

**第三优先（成本与性能）**

9. 让 `AiRoleConfig` 真正可配置（深度/快速分模型），或明确删掉这些字段避免"配置存在但无效"（F-10）。
10. 投影改为增量重算或降级为启动期缓存（F-12）。
11. 报告坏题时补一次质检/重出题（F-13）。
12. 效果摘要的键加入实际策略与每轮题型（F-16）。

---

## 7. 确认没有问题的部分（避免误判）

以下环节经核查与文档要求一致，本次未发现问题：

- **答案不泄露（措辞已按第二轮复核收窄）**：作答前界面只展示题目与提示按钮，来源片段与判据在提交后才渲染（`AdaptiveReviewPage.tsx:190-234`，测试 `AdaptiveReviewPage.test.tsx:34-42`）。**注意**：这只证明"界面不渲染"，不证明"题目本身不含答案"；不存在任何泄漏检测，详见 F-20。
- **四类结果不混淆**：主观自评 / 即时判题 / 执行处置 / 延迟保持分开保存并强校验形态（`validation.ts:84-98`）；空评论、跳过、"没时间"都不会被写成学习结果（`orchestrator.ts:226,795-799`、`repository.ts:143`）。
- **来源可追溯（限"是否落在冻结输入内"）**：蓝图候选要校验主块唯一性、版本一致、证据哈希逐字匹配（`orchestrator.ts:158-197`）；出题来源必须落在蓝图 evidence 集合内（`orchestrator.ts:712-714`），判题引用的判据必须属于本题 `answerCriteria`（`orchestrator.ts:777-778`）。**注意**：该校验不区分主块与同批其他块，跨块支持关闭时仍可引用其他块的反馈与证据，详见 F-19。
- **幂等与墓碑**：`ensureIdempotentInsert` + `idempotencyKey` 唯一约束覆盖全部事件类实体，重复提交不会重复计费或重复落库；撤回评分会把块级评论与队列项一并墓碑化（`storageAdapter.ts:1469-1482`）。
- **冻结输入不可变**：批次创建后 `inputFingerprint`/`inputRefs` 不允许修改，失败子批次可重试、已成功子批次不会重复调用（`repository.ts:819-861`、`orchestrator.ts:458-460`）。
- **唯一当前任务 / 同块同版本唯一开放任务**由数据库唯一索引兜底（`repository.ts:899-909`），并有 `multiple-current-tasks`、`duplicate-open-task` 校验（`validation.ts:216-231`）。
- **冲突处理**：最后一轮判错但自评"已掌握"必须二次确认，且两个事实都保留（`orchestrator.ts:823`、`validation.ts:250-259`）。
- **隐私边界**：Provider 原始响应、Prompt、API Key 在正式快照与同步/导出边界被剥离（`repository.ts:199-216,335-353`）。
- **调度防饥饿**：等待 7 天提升一档，连续两个到期验证后优先普通任务（`orchestrator.ts:205-219,891-896`）。

---

## 8. 需要产品/工程决策的问题

1. **"学习效果"的口径由谁定？** 如果要以客观判题为准，需要接受"用户自评与客观判题可能长期不一致"，并决定以哪个驱动界面文案。
2. **是否允许系统自动重新规划？** 目前文档 6.2 要求深度调用必须用户确认，而 10.3 又要求自动重新规划。F-03 的修复需要在这两条之间取一个明确立场。
3. **深度/快速是否真的要分模型？** 若确定不分，建议从 `AiRoleConfig` 移除 `providerId/model`，避免"看似可配、实际无效"。
4. **块内容变更后的历史是否应该可见？** 这直接影响 F-09 的修复形态（提示 vs 自动重跑）。
5. 提醒：`AGENTS.md` 中记录的"物理设备覆盖升级"与"受控真实 Firebase 账号账单核对"仍是发布门槛；本报告不改变该结论。

---

## 附录 A：本次未执行的动作

- 未运行任何测试套件（只读审计，避免产生构建产物与快照噪音）；
- 未调用任何真实 AI Provider；
- 未修改任何源码、测试、文档或数据库；
- 本报告为新增文档，未触碰既有审计报告。

## 附录 B：建议的验证方式（供修复时使用）

| 发现 | 验证方式 |
| --- | --- |
| F-01 | 构造两个样本量 ≥ 3 的效果摘要，断言 `planSession` 收到的 input 中包含效果摘要 |
| F-02 | 构造"AI 判 incorrect + 自评 mastered"的任务，断言客观指标与自评指标分离 |
| F-03 | `completeDelayedVerification("decayed")` 后断言新增 `delayed-verification-decay` 队列项 |
| F-04 | 断言 `buildQuizTurnPrompt` 中的取值集合与 `practiceTypes` 完全相等 |
| F-06 | 上一轮 `assessment = "unreliable"` 时断言 `requestedStrategy` 不是 `continue`（或断言映射到指定分支） |
| F-08 | T1 自评 mastered、T2 新增反馈，断言投影为 `needs-analysis` |
| F-09 | 递增 `contentVersion` 后断言界面出现"历史分析已失效"提示（组件测试） |
| F-11 | 构造超大决策块，断言出题在调用 Provider 之前被拒绝 |
| F-17 | 断言 `buildAiMessages` 对驾驶舱调用返回的 system 消息中不含"Markdown/LaTeX/列出依据来源" |
| F-18 | 断言 `evaluateAnswer` 收到的 input 含原始材料（或断言判据与材料不一致时判为 `unreliable`） |
| F-19 | `allowCrossBlockSupport = false` 且子批次含 2 块时，断言引用另一块 feedback/evidence 的候选被拒绝 |
| F-20 | 构造题面包含 `answerCriteria` 文本的候选，断言出题流程拒绝或替换该题（并为开放题加入质检分支） |

---

## 9. 第二轮复核：与另一份独立审计的交叉核对（2026-09-14 20:02 起）

第二轮任务：核对另一份针对同一问题（"AI 驾驶舱是否存在逻辑不符/潜在 bug，以及有没有真正的学习效果"）的审计结论，逐条验证其证据，找出本报告的漏项与过度结论，并记录两方分歧。**本轮同样未修改任何源码、测试或数据；仅对本报告增补 F-17~F-20 并修正 2 处过度表述。**

### 9.1 逐条核对结果

对方共列出 5 项严重 + 5 项高风险（另有 1 项"改进项"未在其正文中列名，本报告无法核对）。核对结论：

| 对方条目 | 证据是否成立 | 本报告对应 | 覆盖情况 |
| --- | --- | --- | --- |
| 严重① 效果摘要没进入下一次深度规划 | ✅ 成立（复核 `sessionPlanningGateway.ts:29-50` 的 input 只有 `blocks`/`allowedSupportingDecisionBlockIds`） | F-01（P0） | 已覆盖，结论一致 |
| 严重② Review Coach 继承普通问答全局 System Prompt，与结构化 JSON 冲突 | ✅ 成立（`aiClientService.ts:224` 无条件注入 `SYSTEM_PROMPT`） | **F-17（新增）** | **本报告漏项** |
| 严重③ 出题 Prompt 与解析器题型枚举不一致 | ✅ 成立（与 F-04 同一处） | F-04（P1） | 已覆盖，结论一致 |
| 严重④ 答案评估器看不到原始材料 | ✅ 成立（`orchestrator.ts:774` 未传 `decisionBlockContent`） | **F-18（新增）** | **本报告漏项** |
| 严重⑤ partial/unreliable 可直接提交为"已掌握/仍然掌握" | ✅ 成立（`orchestrator.ts:823,857` 只拦 `incorrect`） | F-02（P0） | 已提及 incorrect 需二次确认，**但未指出 partial/unreliable 连确认都不需要**，本轮已补强 |
| 风险① 关闭跨块支持时其他块的反馈/解释/证据仍可能混入 | ✅ 成立（`orchestrator.ts:177-194` 用的是全批并集，门禁只在 `supportingDecisionBlockIds`） | **F-19（新增）** | **本报告漏项** |
| 风险② 延期中的普通任务可能长期阻止同一知识点的到期验证 | ✅ 成立 | F-15（P3） | 已覆盖，结论一致（严重度我给 P3，对方给高风险，属定级差异见 9.3） |
| 风险③ 效果统计按最初题型归因，未记录实际讲解/提示/例题/前置检查 | ✅ 成立（`strategyKey` 不含策略，`practiceType` 只用 `initialPracticeType`） | F-14（P3） | 已覆盖，结论一致（定级差异同上） |
| 风险④ 没有可靠的答案泄漏检测，测试只验证 UI 不提前显示 | ✅ 成立（全仓唯一相关文本是提示词 `quizExecutionGateway.ts:46`；`AdaptiveReviewPage.test.tsx:34-42` 只断言 DOM） | **F-20（新增）** | **本报告原把它列为"确认无问题"，属过度结论，已修正** |
| 风险⑤ 多个 Blueprint 字段只保存不执行 | ✅ 成立（与本报告 F-05 的字段清单一致：`maxRetriesPerTurn`、`maxEstimatedTokens`、`forbiddenScope` 等） | F-05（P1） | 已覆盖，结论一致 |

**结论层面**：两方对核心判断**完全一致**——记录层与主动回忆/延迟验证/事实分离是正确基础，但"按个人学习效果自动优化教学"的闭环未成立；自评按钮产出的"掌握/保持率"不能当作可靠学习证据。差异只在**漏项**与**严重度定级**，不存在结论冲突。

### 9.2 本报告新增的 4 项（对方发现、我第一轮未覆盖）

#### F-17（P1）驾驶舱 5 个 AI 角色共用了普通问答的全局 System Prompt

`sendChatCompletionDetailed` 最终都走 `buildAiMessages`，而该函数**无条件**把 `SYSTEM_PROMPT` 推为第一条 system 消息（`aiClientService.ts:224`），Review Coach 的 5 个网关（`aiGateway.ts:67`、`sessionPlanningGateway.ts:54`、`quizExecutionGateway.ts:32`）全部传 `history: []`，但**没有关闭这条全局提示**。

冲突点逐句对照 `aiClientService.ts:64-69`：

| 全局 System Prompt 要求 | 驾驶舱同时要求 |
| --- | --- |
| "使用 Markdown 和 LaTeX，不要输出 HTML"（:68） | "必须只输出 JSON，不要 Markdown，不要代码围栏"（`aiGateway.ts:45`、`quizExecutionGateway.ts:27`）；LaTeX 还会往 JSON 字符串里塞反斜杠与 `$` |
| "使用日志内容时，结尾简短列出依据来源"（:68） | "不得增加其他字段"、本地按 `additionalProperties: false` 严格校验（`aiSchemas.ts:280-283`） |
| "如果用户要求出题、批改、追问或测试，请按用户当前要求决定是否给答案"（:67） | 出题"不得泄露答案或判据"、闭卷（`quizExecutionGateway.ts:46`） |

旁证：`parseJsonContent` 专门写了剥除 ```json 围栏的逻辑（`aiGateway.ts:29`），说明团队**已经遇到过 Markdown 围栏问题**，但选择在解析端打补丁，而没有移除冲突指令；且该正则要求围栏包裹全文，一旦模型按 :68 在 JSON 后面追加"依据来源"，剥离失败即 `JSON.parse` 报错。这是 F-04 之外**第二个**会实际抬高失败率（并因此重复计费）的确定性成因。

**修复方向**：为驾驶舱各角色传入角色级 system prompt（或允许调用方覆盖 `SYSTEM_PROMPT`），并把"JSON-only / 不得追加依据来源"写进该角色 prompt。

#### F-18（P1）答案评估器看不到原始材料，只按出题模型自写的判据评分

`submitQuizAnswer` 传给评估器的输入是 `{ blueprint, question, answerCriteria, answerText, hintsUsed }`（`orchestrator.ts:774`），**不含 `decisionBlockContent`**——而同一条链上游的 `generateTurn`（`:696`）和 `reviewQuestion`（`:722`）都传了原始材料，唯独评分环节没传。蓝图里的 `evidence` 只有 `excerptHash`，无正文，所以评估器**无法**用哈希恢复材料。

后果：判据由出题模型自己写（`answerCriteria`），评估器只能在这套判据内部做一致性判断。若判据本身写错（把"入队前标记"写成"出队前标记"），出题与评分会形成**自洽但错误**的闭环，且本地唯一的护栏是"引用的判据必须逐字来自本题 `answerCriteria`"（`orchestrator.ts:777-778`）——这条恰恰保证了错误判据被原样继承。

#### F-19（P1）关闭跨块支持时，其他块的反馈/解释/证据仍可进入 Blueprint

子批次最多含 3 个块，prompt 会把**全部同批块**的 `contextMarkdown`、原始评论与结构化解释一并送出（`orchestrator.ts:476-500`）。校验时：

- `allowedSupportingDecisionBlockIds` 在 `allowCrossBlockSupport === false` 时为空（`:501`），且 `supportingDecisionBlockIds` 会被严格拒绝（`:173-176`）——**这一层是有效的**；
- 但 `feedbackIds` 的校验基准是 `blocks.flatMap(...)` 的**全批并集**（`:177`），只要求"至少命中一个主块反馈"（`:180`）；`interpretationIds`（`:178,183`）与 `evidence`（`:189-193`，任何在批内的块都通过）同样是全批并集。

所以"关闭跨块"实际只关闭了辅助块**声明**，没有关闭辅助块**内容引用**。文档 7.3 要求"辅助块必须由用户确认相关"，而用户取消勾选后系统仍允许模型引用其他块的事实。

#### F-20（P2）没有答案泄漏检测

全仓检索 `泄漏|泄露|leak`，驾驶舱内**唯一**命中是提示词文本 `quizExecutionGateway.ts:46`（"题目中不得泄露答案或判据"）。没有任何本地校验去比对"题目正文是否包含 `answerCriteria` / 期望关键点 / 来源片段"。质检（`reviewQuestion`）的 5 类严重问题里也没有"答案泄漏"这一项（`aiSchemas.ts:250`），且它只对 `calculation` 与非 `open` 题触发（`orchestrator.ts:719`）——**开放题（默认主形态）完全不经过任何检查**。现有测试只断言 DOM 不渲染（`AdaptiveReviewPage.test.tsx:34-42`），不覆盖题面内容。

### 9.3 我方保留的分歧与说明

1. **严重度定级不同，事实无冲突**：对方把"延期任务阻塞到期验证"与"效果按初始题型归因"列为高风险，本报告给 P3。理由是二者都不会产生错误的学习事实，只会让证据链变慢/变粗；若产品目标是"尽快拿到可信效果证据"，按高风险对待是合理的。
2. **对方引用 `domain.ts:157` 作为题型枚举依据**：正确（`AdaptivePracticeType` 定义处），与 `aiSchemas.ts:127-135` 一致。
3. **对方的测试口径比本报告窄，但不构成矛盾**：对方称"定向运行 11 个 Review Coach 测试文件，共 78 项全部通过"。本报告独立运行同一目录得到 **17 个文件 / 94 项全部通过**（`npx vitest run src/features/reviewCoach`，9.13s），并复现了对方提到的 `act(...)` 警告（出现在 `AdaptiveReviewPage.test.tsx > shows answer evidence after submission and requires confirmation for conflicting mastery`）。因此对方的 78 项应为其自选子集；两方共同证实的一点是——**现有测试全绿并不能证明学习证据有效**，因为漏项 F-04 / F-17 / F-18 / F-19 / F-20 均无对应用例。
4. **"1 项改进项"无法核对**：对方正文未列名，只在其画布中，本报告不做推测。

### 9.4 对方未指出、本报告独有的发现

F-03（延迟验证"衰退"不触发重新规划、`delayed-verification-decay` 与 `replan-after-failure` 两个 eligibility reason 定义即弃用）、F-06（`unreliable` 无分支静默 `continue`）、F-07（首轮把 `practiceType` 塞进 `requestedStrategy`）、F-08（投影被更早结果事件覆盖）、F-09（编辑决策块静默废弃待分析项且无提示）、F-11（出题路径无 token 预算校验）、F-12（投影全量重算挂在 18 处写路径、两张投影表无读取方）、F-13（报告坏题不触发质检）、F-10（深度/快速只分提示不分模型）。

其中 **F-03 与对方"严重①"是同一根因的两端**：①说效果不回流到规划，F-03 说"衰退"连规划请求都不产生；两条一起才构成完整断裂。

### 9.5 本轮对本报告所做的修改

1. 新增 F-17、F-18、F-19、F-20 四条发现并计入第 2 节清单；
2. 第 4 节 F-02 补强：`partial` / `unreliable` 无需二次确认即可写为 `mastered`（`orchestrator.ts:823,857`），因此自评指标被进一步放大；
3. 第 7 节两处**过度结论已改写**：原"答案不泄露"收窄为"UI 层不提前展示答案"；原"来源可追溯"收窄为"仅校验是否落在冻结输入内"，并各自指向 F-20 / F-19。
