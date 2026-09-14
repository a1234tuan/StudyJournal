# AI 驾驶舱（Review Coach）学习效果专项审计报告

> 审计日期：2026-09-14
> 审计方：Codex
> 审计范围：`src/features/reviewCoach/**`、相关 `useAppData` 接线、AI 请求适配、Review Coach 工作台与必要的数据投影逻辑
> 明确排除：语音复述模块及其 Prompt
> 审计性质：代码与测试覆盖面的只读审计；未调用真实 Provider，未修改业务代码

## 1. 执行摘要

AI 驾驶舱已经具备一套结构较完整的学习流程：用户反馈、AI 解释、深度规划、逐轮练习、答案判定、自评、延迟验证和事实投影都有对应的数据结构与事务边界。

但从“到底有没有真正的学习效果”这一核心问题看，当前系统还不能给出可信答案：

1. 关键学习效果指标由用户自评驱动，已经保存的 AI 客观判题结果没有进入即时正确率或延迟保持率聚合。
2. `InterventionEffectSummary` 只用于重建、校验和界面展示，没有进入下一次深度规划，因此历史效果不会改变后续教学策略。
3. 多项决定教学行为的 Blueprint 字段只被保存或写入 Prompt，没有被本地运行时可靠执行。
4. 出题、质检和判题链路存在合同冲突、来源复核缺失和答案泄漏防线不足，可能生成“流程成功、学习证据不可信”的结果。
5. 延迟验证、重新规划和任务调度之间仍有断点，用户已经衰退或遇到坏题后，不一定能自动得到新的有效训练。

因此，更准确的产品判断是：

> 当前系统能够记录并组织主动回忆训练，但尚未形成可验证、可归因、能反向改进教学的个人学习效果闭环。

这不等于主动回忆训练本身没有价值，而是现有系统数据和控制逻辑不足以证明“AI 驾驶舱让用户学得更好”，也不足以可靠判断“哪一种教学干预对当前用户最有效”。

## 2. 审计方法

本次沿以下主链路检查代码事实：

```text
复习反馈
→ AI 解释
→ 深度规划 SessionBlueprint
→ 自适应出题与质检
→ 用户作答与 AI 判题
→ 用户即时自评
→ 延迟验证
→ DecisionBlockState / InterventionEffectSummary
→ 下一次规划
```

重点核对四类问题：

- Prompt、JSON 合同和本地 Schema 是否一致；
- AI 输出是否经过来源、状态和教学约束复核；
- 学习效果指标是否来自有效证据并能正确归因；
- 已记录的学习结果是否真正回流到后续教学决策。

## 3. 主要发现

### A-01（P0）学习效果摘要没有进入下一次规划

`SessionPlanningPromptInput` 只有 `blocks` 和 `allowedSupportingDecisionBlockIds`，见 `src/features/reviewCoach/sessionPlanningGateway.ts:29-32`。`orchestrator.analyzeFeedback` 调用 `planSession` 时也没有传递 `InterventionEffectSummary`，见 `src/features/reviewCoach/orchestrator.ts:475-502`。

当前 `replayInterventionEffectSummaries` 的调用方只负责工作台展示、投影重建和投影一致性检查，没有规划调用方。

影响：系统可以显示过去的保持率，却不会据此调整下一次题型、难度或辅助策略。“个性化学习效果”目前是展示数据，不是教学决策输入。

### A-02（P0）核心成效指标由用户自评驱动，客观判题没有进入聚合

`replayInterventionEffectSummaries` 中：

- `immediateMasteredCount` 来自 `subjectiveOutcome === "mastered"`，见 `src/features/reviewCoach/replay.ts:194,225`；
- `delayedRetainedCount` 和 `delayedDecayedCount` 来自用户提交的延迟验证结果，见 `src/features/reviewCoach/replay.ts:210-229`；
- `answer-assessment` 中保存的 `correct | partial | incorrect | unreliable` 没有进入成效聚合。

报告中的“核心成效指标由自评驱动”不应扩大为“摘要中的所有指标都是自评”。摘要还包含轮数、提示、延期、退出和坏题等过程数据，但这些过程数据不能替代客观学习表现。

影响：用户可以在客观答案不完整或无法判断时形成“已掌握”与“仍然掌握”，保持率可能系统性偏高。

### A-03（P1）Review Coach 的结构化角色继承通用问答 System Prompt

`buildAiMessages` 无条件把通用 `SYSTEM_PROMPT` 放在第一条 system 消息，见 `src/services/aiClientService.ts:216-224`。该 Prompt 要求 Markdown、LaTeX 和依据来源，见 `src/services/aiClientService.ts:64-68`；Review Coach 的角色指令却作为 user 消息要求只输出 JSON、不得 Markdown。

`structuredOutput` 只发送 `response_format: { type: "json_object" }`，没有发送具体 JSON Schema，见 `src/services/aiClientService.ts:382-389`。

影响：高优先级 system 指令与角色 JSON 合同冲突，真实模型可能追加 Markdown、来源说明或额外字段，引发解析失败和重复计费。

### A-04（P1）出题 Prompt 与本地题型枚举直接冲突

出题 Prompt 要求：

```text
concept | calculation | discrimination | cloze | variation | chunk
```

见 `src/features/reviewCoach/quizExecutionGateway.ts:47`。

本地实际允许：

```text
concept-question | calculation | distinction | cloze | variation | chunk-training | prerequisite-check
```

见 `src/features/reviewCoach/aiSchemas.ts:127-135`。

影响：模型严格遵循 Prompt 输出 `concept`、`discrimination` 或 `chunk` 时，反而会被解析器拒绝。这是确定性的契约缺陷，不是模型随机性。

### A-05（P1）答案评估器看不到原始材料，判据一致性校验也不完整

出题和题目质检都能获得 `decisionBlockContent`，见 `src/features/reviewCoach/orchestrator.ts:693-722`；答案评估只收到 Blueprint、问题、出题模型生成的 `answerCriteria`、用户回答和提示次数，见 `src/features/reviewCoach/orchestrator.ts:774`。

本地只检查 `matchedCriteria` 和 `missingCriteria` 中是否出现题目之外的判据，见 `src/features/reviewCoach/orchestrator.ts:777-778`。没有验证：

- 两个数组是否互斥；
- 是否完整覆盖全部判据；
- `assessment=correct` 时是否仍存在 missing；
- `assessment=incorrect` 时是否错误地声明全部 matched。

`parseAnswerEvaluationAiResponse` 也只检查字段类型，见 `src/features/reviewCoach/aiSchemas.ts:408-419`。

影响：出题模型一旦写错判据，评估模型可能在错误判据内部形成自洽评分，用户会得到高置信度但来源错误的反馈。

### A-06（P1）部分正确或无法判断也能直接形成掌握和保持

即时结果只在最后一轮为 `incorrect` 时要求二次确认，见 `src/features/reviewCoach/orchestrator.ts:817-844`；延迟保持同样只拦截 `incorrect`，见 `src/features/reviewCoach/orchestrator.ts:850-866`。

`partial` 和 `unreliable` 可以直接提交为 `mastered` 或 `retained`。

影响：证据不足或部分掌握可升级为正式保持事实，并进入保持率分子。

### A-07（P1）延迟验证判为 decayed 后不触发重新规划

普通训练提交 `not-mastered` 时会调用 `recordFeedback` 并重新进入分析，见 `src/features/reviewCoach/orchestrator.ts:843-845`。延迟验证提交 `decayed` 时只完成验证并选择下一任务，见 `src/features/reviewCoach/orchestrator.ts:850-868`。

`AnalysisEligibilityReason` 虽定义了 `delayed-verification-decay`，见 `src/features/reviewCoach/domain.ts:90-94`，但该原因没有进入这条完成路径。

影响：系统已经确认用户遗忘，却不会自动产生新的教学计划，闭环在延迟验证之后断开。

### A-08（P1）分支协议缺失 unreliable，首轮策略字段也混入题型

`ImmediateAnswerAssessment` 包含 `unreliable`，但 `BlueprintBranch.when` 只有 `correct | partial | incorrect | skipped`，见 `src/features/reviewCoach/domain.ts:171-173,237-238`。

运行时找不到 `unreliable` 分支后会回退到 `continue`；首轮又把 `blueprint.initialPracticeType` 写入语义上应为教学策略的 `requestedStrategy`，见 `src/features/reviewCoach/orchestrator.ts:687-706`。

影响：最需要澄清或换题的“不可靠判定”被静默当作继续，首轮请求还携带语义域错误的数据。

### A-09（P1）多项 Blueprint 字段只是元数据，没有确定性执行

Blueprint 保存了 `initialDifficulty`、`expectedKeyPoints`、`allowedStrategies`、`forbiddenScope`、`maxRetriesPerTurn`、`maxEstimatedTokens` 和 `completionCriteria` 等字段，见 `src/features/reviewCoach/orchestrator.ts:584-607`。

运行时明确执行的主要是 `maxTurns`，见 `src/features/reviewCoach/orchestrator.ts:675-678`。题目生成重试固定为两次，见 `src/features/reviewCoach/orchestrator.ts:692`，没有读取 `maxRetriesPerTurn`；模型实际采用的策略也没有返回字段供本地检查。

影响：系统表面上拥有严格教学蓝图，但低成本执行模型是否遵守难度、策略、范围和费用约束主要依赖 Prompt 自律。

### A-10（P1）旧结果事件可能覆盖内容更新后的新反馈状态

`replayDecisionBlockState` 先根据活动反馈设置 `needs-analysis`，随后按时间遍历全部自评和验证结果并覆盖状态，见 `src/features/reviewCoach/replay.ts:78-101`。

影响：用户完成过一次训练后又产生新的困惑，旧的“已掌握”或“待验证”事件仍可能覆盖新的 `needs-analysis` 基线，使投影语义与当前事实不一致。

### A-11（P1）关闭跨块支持仍不能阻止其他块内容进入 Blueprint

`supportingDecisionBlockIds` 会受到 `allowCrossBlockSupport` 限制，见 `src/features/reviewCoach/orchestrator.ts:173-176`。但 feedback、interpretation 和 evidence 的合法集合按整个子批次建立，见 `src/features/reviewCoach/orchestrator.ts:177-194`。

影响：用户没有授权跨块支持时，模型仍可能引用同批其他决策块的反馈、解释和材料，只是不把它声明为 supporting block。

### A-12（P2）主动回忆没有可靠的答案泄漏防线，开放题还绕过独立质检

出题 Prompt 只用自然语言要求“题目中不得泄露答案或判据”，见 `src/features/reviewCoach/quizExecutionGateway.ts:46`。质检问题类型没有 `answer-leakage`，见 `src/features/reviewCoach/quizExecutionGateway.ts:56-57` 和 `src/features/reviewCoach/aiSchemas.ts:240-250`。

独立题目质检只用于计算题或非开放题，见 `src/features/reviewCoach/orchestrator.ts:719-730`。现有测试只证明作答前 UI 不显示“答案依据”，见 `src/features/reviewCoach/AdaptiveReviewPage.test.tsx:34-42`，不能证明题面和提示没有泄漏答案。

影响：用户可能完成的是答案识别而非主动提取，任务看似成功却不产生预期记忆效果。

### A-13（P2）五个 AI 角色没有真正独立的模型选择

深度规划和逐轮执行都从当前 AI 设置读取同一个 Provider 和 model，并回写角色配置，见 `src/hooks/useAppData.ts:424-445,516-541`。

`AiRoleConfig` 虽包含 `providerId` 和 `model`，见 `src/features/reviewCoach/domain.ts:360-378`，但当前没有角色级模型配置入口。

影响：所谓“深度模型负责规划、快速模型负责执行”没有在模型选择层实现；出题和质检还默认由同一个模型自审。

### A-14（P2）出题路径没有输入 token 预算

分析路径使用 `maxAnalysisInputTokensForProvider` 并拒绝超限块，见 `src/features/reviewCoach/analysisPlanner.ts:41-46,126-135`。出题路径直接生成完整 `decisionBlockContent` 并调用模型，见 `src/hooks/useAppData.ts:555-568`。

影响：较大的决策块可能在分析阶段被正确拦截，却在逐轮出题时撑爆上下文；错误发生前请求成本已经产生。

### A-15（P2）延期任务可能阻塞到期验证，验证任务还复用原 maxTurns

`refreshDueVerifications` 把 `deferred` 视为同一知识点的开放任务；命中后直接跳过到期验证入队，见 `src/features/reviewCoach/orchestrator.ts:901-914`。延期状态继续保留 `openTargetKey`，见 `src/features/reviewCoach/repository.ts:1150-1156`。

延迟验证任务复用原 Blueprint，并使用相同的 `maxTurns` 判断，见 `src/features/reviewCoach/orchestrator.ts:675-682`。

影响：普通任务长期延期时，真正到期的保持验证可能一直无法开始；一次验证也可能开放与原训练相同的多轮额度。

### A-16（P2）报告坏题只终止任务，不触发质检或补题

`reportInvalidQuestion` 只将该轮和任务标记为 invalid，然后选择下一任务，见 `src/features/reviewCoach/orchestrator.ts:802-815`。

影响：一次坏题会结束整个训练任务，但不会自动重新质检、重新出题或把失败信息反馈给规划器。

### A-17（P2）效果摘要没有按实际发生的教学干预归因

`strategyKey` 使用 `problemType + initialPracticeType + provider + model + promptVersion + policyVersion`，见 `src/features/reviewCoach/replay.ts:176-180`。它不包含实际轮次题型，也不包含 `hint`、`explain`、`worked-example`、`prerequisite-check` 等真实分支策略。

同时，只要任务有 `startedAt` 就可进入样本，见 `src/features/reviewCoach/replay.ts:193-205`；达到三个样本即标记为 usable，见 `src/features/reviewCoach/replay.ts:237-238`。

影响：系统无法回答“哪一种教法对当前用户更有效”，无结果或无效任务还可能让证据过早达到可用门槛。

### A-18（P2）投影采用全量重建，写放大明显且运行期可能短暂失真

`rebuildReviewCoachProjectionsInTransaction` 会读取全部正式事实、重放全部状态、清空两张投影表再整体写回，见 `src/features/reviewCoach/repository.ts:411-435`。

当前 CodeGraph 索引识别到仓储包装方法 `rebuildProjectionsInTransaction` 有 21 个调用者。`saveFeedbackInterpretation` 保存解释时没有触发投影重建，见 `src/features/reviewCoach/repository.ts:727-742`。

影响：数据量增长后，高频写操作可能越来越慢；部分正式事实更新后，持久化投影在运行期间也可能暂时落后。

### A-19（P2）内容更新后的 stale 处理缺少工作台级恢复入口

决策块内容版本更新会把关联队列项、批次、Blueprint、开放任务和验证置为 stale，见 `src/features/reviewCoach/repository.ts:479-494`。这一保护本身正确，可避免旧题继续作用于新内容。

但用户侧只有历史反馈区域的弱提示“源内容已更新”，见 `src/pages/ReviewPage.tsx:1194-1195`；工作台候选会消失，没有明确的重新分析动作。

影响：用户可能不知道为什么原训练计划消失，也不知道如何把仍有价值的旧反馈重新带入规划。

### A-20（P3）未确认的 AI 解释没有明确的证据降级规则

规划输入会包含反馈解释以及 `userConfirmed` 状态，见 `src/features/reviewCoach/analysisPlanner.ts:84-94` 和 `src/features/reviewCoach/orchestrator.ts:484-498`。

但规划 Prompt 只笼统要求使用输入事实，没有说明如何区分：

- 用户原始评论；
- 用户已确认的 AI 解释；
- 尚未确认的 AI 推断。

影响：快速解释模型的推测可能被深度规划模型继续放大，最终形成看似有来源、实际证据等级不清的教学目标。

## 4. 已确认的健康基础

以下能力方向正确，不应因为上述问题而被一并否定：

1. 用户原始反馈与 AI 解释分开保存，解释可以由用户确认或修正。
2. 题目、回答、AI 判定、自评、任务处置和延迟验证是不同正式事实，没有压成一个“掌握度”。
3. 主要事件写入具备事务、幂等键和版本校验。
4. 决策块内容变化会使旧派生工作 stale，避免旧材料继续驱动新训练。
5. 延迟验证独立于记录级 FSRS，没有悄悄改写整条记录的复习计划。
6. 来源 ID、内容版本和 excerpt hash 已有较强的冻结输入校验基础。
7. Prompt、原始 Provider 响应和 API Key 不进入正式学习事实或云端导出边界。

这些基础说明当前问题适合通过修复证据链和控制逻辑解决，不需要推倒整个 Review Coach 数据模型。

## 5. 对“有没有真正学习效果”的最终判断

### 5.1 可以确认的部分

- 系统确实组织了主动回忆、提示、变式练习和延迟验证流程；
- 用户完成了多少轮、用了多少提示、选择了什么处置都能被记录；
- AI 即时判题结果也已经保存为正式事实。

### 5.2 不能确认的部分

- 不能确认用户的知识掌握是否因 AI 驾驶舱而提高；
- 不能用当前保持率证明长期记忆改善，因为保持结果仍由用户按钮决定；
- 不能判断哪种教学策略更有效，因为摘要没有按真实干预归因；
- 不能确认系统会根据过去效果变得更适合当前用户，因为效果没有进入规划。

### 5.3 所需证据

至少需要同时建立：

1. 客观即时表现：基于有效 `answer-assessment` 的正确、部分正确和错误分布；
2. 客观延迟表现：延迟验证中的独立新题表现，而不是只记录“仍然掌握”按钮；
3. 主观自评：继续保留，但与客观证据并列，禁止合并；
4. 干预归因：记录每轮真实题型、提示等级和实际策略；
5. 闭环验证：可证明下一次 Blueprint 确实读取并采用了历史效果证据。

在这些条件完成前，界面应把现有指标明确称为“用户自评保持率”与“训练过程统计”，不宜统称为已验证的学习效果。

## 6. 建议修复顺序

### 第一优先：消除确定性合同错误

1. 为 Review Coach 提供角色级 system prompt，隔离普通问答 Prompt。
2. 由同一枚举源生成题型 Prompt 和 Schema 测试。
3. 拆分 `initialPracticeType` 与 `requestedStrategy`。
4. 为 `unreliable` 定义明确分支。

### 第二优先：修复学习证据有效性

1. 给答案评估器传入原始来源材料。
2. 校验判据分区互斥、完整覆盖及 assessment 一致性。
3. 所有题型执行来源一致性与答案泄漏检查。
4. 禁止 `unreliable` 直接形成 retained；为 partial 定义额外证据门槛。

### 第三优先：闭合个性化学习循环

1. 分开聚合客观表现和主观自评。
2. 按实际发生的干预序列归因效果。
3. 将达到证据门槛的效果摘要传入下一次规划。
4. `decayed` 和可靠的 `not-achieved` 结果进入重新规划队列。

### 第四优先：落实运行时边界

1. 区分 Blueprint 中可执行约束和解释性元数据。
2. 对允许策略、禁止范围、重试和 token 预算做本地检查。
3. 按角色配置模型，或删除当前无效的角色模型配置假象。
4. 严格执行跨块授权边界。

### 第五优先：调度、恢复和性能

1. 定义 deferred 普通任务与到期验证的抢占或并存规则。
2. 坏题上报后自动质检、补题或重新规划。
3. 修正投影状态的事件优先级。
4. 将全量投影重建改为增量或明确的惰性缓存。
5. 为 stale 工作提供明确、可操作的重新分析入口。

## 7. 必须补充的回归测试

1. 每个 Review Coach 角色最终 system/user 消息隔离。
2. Prompt 中的全部 `practiceType` 与解析枚举完全一致。
3. `unreliable` 不得静默回退到普通 continue。
4. 评估器必须收到来源材料。
5. matched/missing 判据重叠、遗漏或与 assessment 矛盾时拒绝结果。
6. open、objective、unique 三类题均覆盖答案泄漏检测。
7. partial/unreliable 不能无条件形成 mastered 或 retained。
8. `allowCrossBlockSupport=false` 时拒绝任何非主块引用。
9. `decayed` 完成后产生明确的重新规划候选。
10. deferred 跨过 `verificationDueAt` 后仍能调度验证。
11. 坏题上报后产生补题、质检或重新规划动作。
12. 三个只有 startedAt、没有有效结果的任务不能让效果证据变 usable。
13. 新反馈晚于旧结果时，状态应回到 needs-analysis。
14. 效果摘要进入下一次规划，并能在受控 Mock 中改变决策。

## 8. 与另一份审计的交叉核对

另一份报告：`docs/audit/ai-cockpit-learning-effect-audit-2026-09-14.md`。

按该报告当前清单中的 19 项独立发现计算：

- 本审计原始版本完整覆盖 7 项；
- 部分覆盖 3 项；
- 明确遗漏 9 项。

两份报告的核心产品结论一致：事实记录基础可信，但客观效果度量和效果驱动教学尚未闭合。不存在根本相反的代码判断。

另一份报告整体覆盖面更广，但有以下表述或文档一致性问题：

1. “效果指标 100% 来自用户自评”应限定为核心成效指标，而不是摘要中的全部过程指标。
2. “修改决策块后界面无提示”不准确；历史反馈区存在“源内容已更新”提示，但缺少工作台级恢复入口。
3. 清单 F-14 与正文 F-16 实际描述同一个效果归因问题，编号不一致。
4. 投影重建“18 处调用点”已经不是当前索引结果；当前仓储包装方法有 21 个调用者。
5. 附录称未运行测试，第二轮章节又记录运行 17 个文件、94 项测试，审计方法记录需要统一。

该报告也没有完整替代本审计中的两个子问题：

- 判据分区缺少互斥、完整覆盖和 assessment 一致性验证；
- 未确认 AI 解释缺少证据降级规则。

## 9. 最终结论

AI 驾驶舱不是一个完全无效的模块。它已经具备主动回忆、事实记录、版本隔离和延迟验证的工程基础。

但当前最核心的缺口不是“Prompt 还不够好”，而是：

```text
客观证据没有进入指标
→ 指标没有按真实干预归因
→ 指标没有回流下一次规划
```

在这条链路闭合前，继续优化 Prompt 只能改善局部输出观感，不能证明真实学习效果。后续修复应优先处理确定性合同、证据有效性和效果回流，再讨论模型选择与 Prompt 微调。
