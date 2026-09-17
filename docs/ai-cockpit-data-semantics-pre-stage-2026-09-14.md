# 前置阶段：锁定数据语义与口径（实施前收口）

> **状态更新（2026-09-15）**：本文是 P0 阶段冻结的数据语义契约。“已改了一部分 A 批代码、等待重新确认”是当时的过程状态；P0-P4 已在 `da8b566` 完成并通过本地验收。本文仍是指标口径和数据边界的设计依据，实施结果以 `docs/archive/ai-cockpit-remediation-acceptance-2026-09-14.md`、`AGENTS.md` 和源码为准。

> 制定日期：2026-09-14
> 定位：**这不是第三份方案**。它是 A/B/C 三批开工前必须先定死的一份**语义契约 + 风险边界**。
> 触发原因：复盘发现上一版方案在 D-1 决策后**自身留下了自相矛盾的表述**，且若干"指标/证据/缓存/排序"概念在文档里混用了。
> 当前工作树状态：**已改了一部分 A 批代码**，见 §6。本文档完成后等待重新确认再继续。

---

## 0. 我对上一版方案的自我修正（先认账）

| # | 我原来的说法 | 问题 | 现在的定性 |
| --- | --- | --- | --- |
| 1 | "选 (b) 意味着 B 批只能回流主观数据" | **错误**。回流用什么指标与界面显示什么，是两件独立的事 | 已在方案 §9.2 第 6 条更正，但 §0.1 / §0.2 / §2 A-2 / §7 / §8 仍残留"界面显示两个数字"的表述 → §1 逐处收口 |
| 2 | "bump `quiz-turn` 版本号，否则改动前后的效果样本会被合并统计" | **错误，且方向搞反了**。`strategyKey` 只取 `blueprint.promptVersion`（`replay.ts:179`），`quiz-turn` / `answer-evaluation` / `question-quality` 的版本号**根本不进键** | 见 §2.5：要么把轮次级版本也纳入键，要么明确接受合并 |
| 3 | C-3 计划"`unreliable` 本地降级按 `partial` 分支" | **错**。`unreliable` 与"答错"是不同语义，降级会污染掌握判定与策略 | 改为"既不降级也不同化为 partial"，见 §3 第 7 条 |
| 4 | 把 `decisionBlockContent` 直接塞进 `evaluateAnswer` 输入 | 方向对，但**只做了"传接"，没做边界声明** | 需补：内容边界标注 + 大小上限 + 记录实际传入范围，见 §3 第 2 条 |
| 5 | "回滚后无数据风险" | 说法不完整：投影回滚会**改变用户看到的统计口径**，这是可见影响 | 改为"不影响正式事实，但会改变投影统计口径"，见 §3 第 10 条 |

---

## 1. D-1 收口：定稿语义（五条约束）

### 1.1 文档里现存的矛盾（待逐处修改）

| 位置 | 残留表述 | 需要改成 |
| --- | --- | --- |
| §0 决策表"本文建议"列 | 仍是"选 (a)…两个数字必须同时可见" | 保留为历史建议即可，但需在列头标明"**未被采纳**" |
| §0.1 正文 | "按口径 B 之后，同一批事实会显示成两个并列数字" | 已加横幅，正文仍需标注为"未发生的假设" |
| §0.2 表 ② | "D-1 要求两个数字**永不合并**" | 改为"D-1(b) 要求客观指标不进入主数字" |
| §2 A-2 第 4、5 条 | 要求工作台"改为两块并列展示"、微调阶段 7 文案 | 改为"**界面不改**，客观指标仅供内部归因" |
| §7 验收清单 | 未提客观指标的验收方式 | 补"客观指标的可审计性"验收 |
| §8 一句话总结 | "让证据能回流"未区分主口径 | 补一句口径说明 |

### 1.2 定稿语义（这五条是契约，实现不得偏离）

1. **主口径仍是自评。** 界面主卡片文案一字不改（`ReviewCoachWorkbench.tsx:273-289` 现在写的就是"用户自评保持率"）。
2. **客观指标必须被计算、入库、可审计**，但**默认不展示**。它存在的理由是内部归因与"未来可低成本开启展示"，不是为了给用户看。
3. **两个口径互不影响。**
   - 自评不因客观样本不足而降级（`evidenceStatus` 语义不动）
   - 客观不因自评缺失而消失（`objectiveEvidenceStatus` 独立）
   - **不得出现任何"合并后的单一数字"**
4. **驱动策略的是客观指标，界面文案保持"自评"字样。** 二者**不得混用、不得互相解释**。这是本决策下最容易写错的一条：`planSession` 收到的效果输入里**只允许出现客观字段**（`objectiveCorrectRate` / `verificationObjectiveCorrectRate` / `objectiveUnreliableCount` / `strategyKey`），**禁止出现 `retentionRate` / `selfReportedMasteredCount`**。
5. **每个数字必须带自己的分子/分母/样本量与可用性判定。** 任何人拿到一份效果摘要，都要能回答"这个百分比是几个样本算出来的、排除了什么"。

### 1.3 与"学习效果"的关系（诚实表述）

- 这套改造**本身不产生学习效果**。
- 它使系统内部第一次能区分"用户觉得自己会了"和"客观答对了"，从而让"换一种教法"有依据。
- **但用户不会看到这个区分**（(b) 的直接代价）。所以"帮我发现我的自评不可靠"这个元认知收益，这一轮**拿不到**。

---

## 2. 数据语义基线（写代码前必须固定）

### 2.1 五类事实与它们的角色

| 事实 | 载体 | 谁写入 | 进同步/快照？ | 可重算？ |
| --- | --- | --- | --- | --- |
| 用户自评 | `TaskOutcomeEvent(kind=self-assessment)` | 用户点按 → `orchestrator.finishQuizTask` / `completeDelayedVerification` | **是**（正式事实） | 否（不可变的用户输入） |
| AI 逐轮判题 | `TaskOutcomeEvent(kind=answer-assessment)` + `AdaptiveQuizTurn.assessment` | `orchestrator.submitQuizAnswer` / `skipQuizTurn` | **是** | 否（是当时的模型输出） |
| 题目本身 | `AdaptiveQuizTurn` | `generateQuizTurn` | **是** | 否 |
| 投影状态 | `DecisionBlockState` / `InterventionEffectSummary` | `rebuildReviewCoachProjectionsInTransaction` | **否**（`backup.test.ts:127`、`formalRoundTrip.test.ts:98` 已断言） | **是**（全量重建） |
| 效果分桶键 | `strategyKey`（投影内字段） | `replay.ts` 计算 | 否 | **是** |

**关键推论**：A/B 批只动最后两行。**正式事实一个字段都不改**，这是"不改 schema、不改同步契约"的真正含义。

### 2.2 每个指标的分子 / 分母 / 去重键 / 排除项 / 样本量

| 指标 | 分子 | 分母 | 去重键 | 排除项 | 样本量字段 |
| --- | --- | --- | --- | --- | --- |
| `selfReportedMasteredCount`（即时掌握） | `self-assessment` 且 `subjectiveOutcome=mastered` 的**任务数** | — | `idempotencyKey = self-assessment:${operationId}` | `deletedAt`、非本组任务 | `sampleCount` |
| `retentionRate`（自评保持率，**主口径**） | `verificationOutcome=retained` | `retained + decayed`（仅 `status=completed` 的验证） | `idempotencyKey = verification:${selfAssessment.id}` | 未完成的验证 | `delayedRetainedCount + delayedDecayedCount` |
| `objectiveCorrectRate`（客观答对率） | `answer-assessment` 且 `correct` | `correct + partial + incorrect` | 一条 `answer-assessment` 事件 | **`unreliable`**、`deletedAt`、验证任务轮次 | `objectiveAnswerCount` |
| `verificationObjectiveCorrectRate` | 同上，限**验证任务**的轮次 | 同上 | 同上 | 同上 | `verificationObjectiveCount` |
| `masteryAssessmentBreakdown` | 自评 `mastered` 的任务按**末轮判题**分类计数 | — | 任务级（每个任务 +1） | 末轮为 `unreliable` 的任务（不猜） | 三项之和 |
| `averageTurnsToMastery` | 任务轮次数 | 自评 mastered 的任务数 | 任务级 | `[skipped]` 轮（A-3 起） | `masteredTaskIds.size` |

**"一个任务只贡献一次"的适用范围**：`masteryAssessmentBreakdown`、`averageTurnsToMastery`、`sampleCount` 都是**任务级**；`objectiveCorrectRate` 是**轮次级**。这两个层级不得混用——这是最容易被后续维护者写错的地方。

### 2.3 去重规则（已核实，不是假设）

| 事实 | 去重机制 | 代码依据 |
| --- | --- | --- |
| 一个轮次最多一条 `answer-assessment` | **状态机硬约束**：`answered → answered` 非法（`displayed → answered\|invalid`、`answered → invalid`）；`commitQuizAnswer` 在 `current.status === "answered"` 时短路返回 | `stateMachines.ts:76-80`、`repository.ts:1048-1052` |
| 同一 `operationId` 重复提交 | `ensureIdempotentInsert` 按 `idempotencyKey` 去重，且内容不一致即抛错 | `repository.ts:113-125` |
| 全局重复 | `validateReviewCoachFormalSnapshot` 拒绝重复 `idempotencyKey` | `replay.test.ts:29-36` |

**结论**：`objectiveAnswerCount` 当前**不会因同一轮次被重复计数**。但这依赖状态机，不依赖指标层——所以 §5 要求补一条回归测试把这条不变量钉住，而不是靠注释。

### 2.4 乱序与时钟（这是**风险**，不是已解决的问题）

**已知事实**（核实结果）：

- 跨设备**没有全局顺序**。`occurredAt` 来自写入方本地时钟（`this.dependencies.clock.now()`）。
- 云同步按**实体**合并（`mergeCloudSyncEntities`），且实体哈希**排除 `updatedAt`**（`cloudSyncModel.ts:172-184` 明确写"updatedAt is bookkeeping, not content"）。
- 因此"哪个先发生"在合并后**无法从存储层恢复**。

**因此定死三条算法约束**：

1. 任何效果算法必须是**顺序无关的**（对同一事实集合，任意输入顺序产出相同结果）——`replay.test.ts` 已有先例，A-3/B-1 必须延续。
2. 需要"最新"语义（如末轮判题）时，必须使用**确定性比较器**，不得依赖数组顺序：
   `(occurredAt, turn.sequence, id)` 字典序，其中 `turn.sequence` 优先于 `id`。
3. **本轮不做跨设备时间裁决**。B-1 只做"事实分层 + 层内确定性排序"，不引入"用时间戳决定谁覆盖谁"的跨设备逻辑。跨设备因果顺序列为**未解决问题**，写入 §5 遗留项。

### 2.5 稳定性边界：哪些字段可以跨版本比较（含对我自己的更正）

**更正**：我此前说"bump `quiz-turn` 版本号以免效果样本被合并统计"——**这是错的**。`strategyKey` 的构成是（`replay.ts:179`）：

```
[problemType, blueprint.initialPracticeType, blueprint.provider, blueprint.model,
 blueprint.promptVersion, blueprint.policyVersion].join(":")
```

即**只有 `session-blueprint` 的 promptVersion 进键**。`quiz-turn` / `answer-evaluation` / `question-quality` 的版本号只被记录在实体上，**不参与分桶**。

**这带来一个必须现在决定的问题**：C 批会改出题与判题的提示词（C-1 指令环境、C-2 枚举同源、C-3 分支）。若不处理，改动前后的效果样本会**被合并**，A 批刚建立的可信指标立刻失真。两个选项：

| 选项 | 做法 | 代价 |
| --- | --- | --- |
| **(i) 扩展键**（建议） | A-3 本来就要改 `strategyKey`（加 `actualPracticeType` / `hintLevelUsed`），顺带加入该组轮次出现的**轮次级 promptVersion 集合**（排序后 join） | 键变长；分桶更碎，样本更少；但归因**正确** |
| (ii) 接受合并 | 明确记录"跨提示词制度的样本会被合并"，并在文档里声明该指标在改版窗口期内不可用于比较 | 零改动；但 A 批的收益在 C 批落地当天打折 |

**其他稳定性边界**：

- `replayFingerprint` **是**内容哈希，但"跨 `replayVersion` 比较它是无意义的"（注释已写"不要用 hash 兼容性冒充业务兼容性"）。
- `policyVersion` 恒为 `review-coach-policy-v1`，当前不构成变量。
- 结论：**唯一稳定的比较单位是"事实组合键（`strategyKey`）× 明确的语义版本"**，不是 `replayFingerprint`，也不是 `updatedAt`。

---

## 3. 逐条回应你的 10 点

| # | 你的判断 | 我的核实结论 | 处置 |
| --- | --- | --- | --- |
| 1 | D-1 语义冲突 | **成立**。§0.1/§2 A-2/§7/§8 与 D-1(b) 冲突 | §1 逐处收口 + 五条契约 |
| 2 | A-1 输入边界 | **部分成立**。事实是：上下文包**只含单个决策块**（`aiContextService.ts:669-691` 只取 `decisionBlock.innerHtml`），所以外泄面小于担心；但"未声明内容边界"确实成立 | 补：注入时标注"用户学习内容，非指令"、加大小上限（已做 `assertTurnContextBudget`）、把实际传入字符数/块 id 记入调用记录 |
| 3 | 分母与去重规则未定义 | **成立** | §2.2 / §2.3 定死 |
| 4 | 时间戳跨设备不一致、幂等重算、测试防御 | **成立，且比我原以为的更严重**（§2.4） | §2.4 三条算法约束；**本轮不做跨设备时间裁决** |
| 5 | B-3 invariants 必须进测试 | **成立** | §5 列为必测项 |
| 6 | C-1 全链路 + 重试/降级/原生/回放 | **成立**（我会核实到每个入口） | 见 §4 |
| 7 | `unreliable` 不应降级为 partial | **成立，我原方案错了** | 改为见下方 |
| 8 | C-4 检测边界 | **成立** | 见下方 |
| 9 | 语音 P1 / 测试失败 / R11 | **两个不成立，一个成立但性质不同**（见 §3.1） | 不修（冻结区），记录 |
| 10 | 不改 schema ≠ 无数据风险；需调顺序 | **成立** | §5 调整顺序 |

### 3.1 关于第 9 点的核实结果（三个断言分别核对）

| 断言 | 核实结论 | 证据 |
| --- | --- | --- |
| "完整确定性测试仍有失败" | **不成立** | 我本轮实跑全量：`Test Files 169 passed \| 2 skipped`、`Tests 1059 passed \| 2 skipped`、**0 失败**（2 项 skipped 是付费 live 测试）。项目自己的 `docs/audit/final-full-audit-2026-09-14.md` §0 已明确把该结论**证伪**，并把根因记为 **F-29：测试基础设施脆弱性**（`storageAdapter.restore/review` 最慢用例 2.5–3.5s 对 5s 超时，余量过小，并发下必然假失败）。原始草稿已归档为 `docs/audit/superseded-subagent-draft-2026-09-14.md` |
| "R11 用量记账仍有问题" | **不成立** | `auditRegression.test.tsx` 16/16 通过，其中 `R11 saves nonzero measured usage in local history` 明确通过；修复口径记录在 `docs/second-audit-repair-acceptance.md:28` |
| "`runtimeController.pause()` 在 idle 状态可能 dispatch 非法 PAUSE" | **成立，但性质是"静态可达的潜在缺陷"，不是测试失败** | 见下 |

**关于 `pause()` 的可达性（我自己逐行走了一遍，这比原报告更精确）**：

- `domain.ts:175-176`：`PAUSE` 要求 `activeStatuses`，该集合 = `connecting/listening/finalizing-asr/thinking/speaking/reconnecting/failed`，**不含 `idle`**。未命中则落到 `:213` 抛 `VoiceRecallTransitionError`。
- `runtimeController.ts:331-332`：`pause()` 只排除 `!state / paused / ended`，**未排除 `idle`**。
- `runtimeController.ts:76-97`：`createSession()` 把 `this.state` 置为 **`idle`**，随后**立刻** `this.focus.start()`。
- `VoiceRecallWorkspace.tsx:327`：卸载时 `void runtime.disposeView()`，而 `disposeView()` 就是 `pause()`。

→ **两条真实可达路径**：
1. `createSession()` 后仍处于 `idle`（用户还没点连接）→ 音频焦点丢失 → focus 回调 `void this.pause()` → 抛错 → **未处理 rejection**；
2. 同上状态下直接离开工作区 → 卸载 → `disposeView()` → 同样抛错 → 未处理 rejection。

**为什么干净测试跑不出来**：现有测试从不构造"`createSession` 后停留在 `idle` 再卸载/失焦"的场景；而"从未创建 session 就卸载"会因 `this.state` 为 `undefined` 在 `pause()` 第一行早退，所以看起来无害。

**处置**：属 `src/features/voiceRecall/**`，已被 `AGENTS.md` 与 `docs/voice-recall-freeze-2026-09-11.md` **冻结**，**本轮不改**。已作为独立静态发现记录（见 §5 遗留项），建议单独开一轮处理，并明确它**不是**"全量测试失败"的证据。

### 3.2 第 7 点：`unreliable` 的正确语义（我原方案作废）

**作废**：不再"本地降级按 `partial` 分支"。理由正如你所说——`unreliable` 混合了"模型判不了"与"用户跳过"（`orchestrator.ts:797` 的 skip 也写 `unreliable`），把它当答错会污染掌握判定。

**改为三条独立约束**：

1. **不进作答命中率的分子或分母**（已在 A-2 落地）。
2. **不自动升高或降低难度**，也不自动进入/退出"掌握"判定。
3. **触发一次"再验证"而不是一次"改策略"**：优先让模型在更完整的材料下重判一次（A-1 之后材料已具备）；重判仍为 `unreliable` 时，向用户提示"这道题暂时无法可靠判定"，并把该轮标为不可评估，**不写任何策略决策**。

### 3.3 第 8 点：C-4 泄漏检查的边界（照你的要求定死）

- **必须确定性**：纯字符串/规范化子串比较，**不调用模型**。
- **只把"能可靠判定的泄漏"当严重问题**。判据过短（如单个词 ≤2 字符）时**静默跳过**，避免误杀。
- **不静默删除题**：命中即走既有"质检失败 → 重出一题"路径（`generateQuizTurn` 的重试分支），并记录命中原因。
- **检查范围**：`question` + `hints`；A-1 之后同步检查"答案评估输入"是否把 `answerCriteria` 当作可引用事实回注。
- **定位**：这是**必要非充分**——它只能拦住"判据文本原样出现在题面"这一种，拦不住语义等价改写。文档里必须写清这一边界。

---

## 4. C 批安全边界（照你的第二点）

| 要求 | 具体做法 |
| --- | --- |
| 提示词入口全覆盖 | 传 `systemPrompt` 的入口必须穷举：3 个驾驶舱网关（`aiGateway.ts:67`、`sessionPlanningGateway.ts:54`、`quizExecutionGateway.ts:32`）+ **知识播客**（`knowledgePodcastService.ts:542`，F-21）。普通问答（`sendChatCompletion`）**保持不变** |
| 重试路径 | `aiRetry` 只重发**同一份 `messages`**，不会重建 system prompt —— 需补一条测试断言"重试不产生第二条 system 消息" |
| 降级路径 | `insufficient-context` 分支不受影响；`AiSchemaError` 仍 `retryable=false`（本项不改变它） |
| 原生路径 | `runNativeAiChat` 只序列化 `messages`（`nativeAi.ts:34-42`）→ 与 Web 共用，**无需改宿主**；但需在 Desktop/Android 各验一次 |
| 回放路径 | `REVIEW_COACH_REPLAY_VERSION` 提到 v3 会强制一次投影重建；**重建不得依赖提示词内容**（只依赖版本号），需断言 |
| 隐私边界 | `decisionBlockContent` 是**用户自己的学习内容**，且上下文包**只含单个决策块**（已核实）→ 不额外扩大外泄面；但必须显式声明"内容非指令" |
| 预算与长度 | 已加 `assertTurnContextBudget`（A-1）；**禁止把全部决策块无限注入** |
| 失败回退 | `systemPrompt` 不传即回退全局提示词，行为与改动前一致（有测试钉住） |
| 兼容性 | 不改 schema、不改同步契约、不改 `AiRoleConfig` 语义 |

---

## 5. 修订后的实施顺序（按你的建议）

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| **P0 前置** | **本文档**：语义契约 + 风险边界固定 | 你确认本文档 |
| **P1 低风险** | **A-2**（客观指标入库，界面零改动）+ **A-3**（归因键扩展，含 §2.5 选项 (i)） | 定向测试 + 全量回归 + 顺序无关性断言 |
| **P2 中风险** | **B-1**（投影优先级，确定性排序）+ **B-2**（只读回流，只送客观字段）+ **B-3**（衰退提示，带 invariants 测试） | 含"不误判、不自动改教法、不写正式事实、不重复排队"四条断言 |
| **P3 高风险** | **C-1**（角色提示词）+ **C-1b**（播客）+ **C-2**（同源）+ **C-3**（`unreliable` 三约束）+ **C-4**（本地泄漏检查）+ **C-5**（跨块门禁） | 每个入口有测试；预算是硬门槛 |
| **P4 验收** | 全量测试 + build + 一次付费受控 Provider 验收 + 文档交付 | 验收记录写入 `docs/` |

**说明**：高风险项不是不做，而是**放在测试保护更完整之后**，并且每个 C 项都要额外满足"若不满足就保持旧行为"的回退要求。

---

## 6. 我在你叫停时已做的代码改动（工作树现状）

**已完成且自测通过（A-1 全部 + A-2 的一半）**：

| 文件 | 改动 | 状态 |
| --- | --- | --- |
| `src/features/reviewCoach/contextBudget.ts` | 新增：`assertTurnContextBudget`（复用分析路径上限） | 新增，4 项单测通过 |
| `src/features/reviewCoach/contextBudget.test.ts` | 新增 | 通过 |
| `src/features/reviewCoach/orchestrator.ts` | `SubmitQuizAnswerInput.decisionBlockContent`（必填）+ 传入 `evaluateAnswer` | 通过 |
| `src/features/reviewCoach/quizExecutionGateway.ts` | 评估器指令加"判据可能不准、冲突须判 `unreliable`"；`maxTokens` 1000 → 1400 | 通过 |
| `src/hooks/useAppData.ts` | `submitAdaptiveQuizAnswer` 构造材料 + 预算校验 | 通过（tsc 通过） |
| `src/features/reviewCoach/aiSchemas.ts` | `ANSWER_EVALUATION_PROMPT_VERSION` → `answer-evaluation-v2` | 通过 |
| `src/features/reviewCoach/aiSchemas.test.ts` | 版本断言改为显式版本表 | 通过 |
| `src/features/reviewCoach/stage6Orchestrator.test.ts` | 补 1 条"评估器确实收到材料"用例 + 2 处调用点适配 | 通过 |
| `src/features/reviewCoach/quizExecutionGateway.test.ts` | 补 1 条材料/指令/预算用例 | 通过 |
| `src/features/reviewCoach/domain.ts` | `InterventionEffectSummary` 增客观字段 + `selfReportedMasteredCount` + `objectiveEvidenceStatus` | 已加，**未验收** |
| `src/features/reviewCoach/replay.ts` | 客观指标聚合 + `REVIEW_COACH_REPLAY_VERSION` → v3 | 已加，**未验收** |

**验证结果**：`npx vitest run src/features/reviewCoach` → 17 文件 / 96 项通过；`npx tsc -b` → 0 错误；`npm run test` 全量 → **169 文件 / 1059 项通过，0 失败**。

**未做**：A-2 的测试文件与 A-3、B 批、C 批全部未开始。

> **收官补记（2026-09-14）**：两项拍板均已执行——(1) 保留现有改动；(2) §2.5 选 (i)。A/B/C 三批已全部落地并通过本地验收（175 文件 / 1108 项，0 失败），验收记录见 `docs/archive/ai-cockpit-remediation-acceptance-2026-09-14.md`；唯一未关闭的门是付费 Provider 验收。§2.4 约束 1 在 A-3 落地时抓到一个真实缺陷（`replayFingerprint` 把数组顺序算进哈希），已修复并有测试钉住。

**下一步需要你拍板两件事**：

1. **A-2/A-3 的存放是否按 P1 重做**：现有改动与 D-1(b) 契约一致（客观字段只入库、界面零改动），可以保留继续；也可以回滚到干净状态后按 P1 顺序重来。**我建议保留**，因为它不含任何界面或口径变更。
2. **§2.5 的选项 (i) 还是 (ii)**（`strategyKey` 是否纳入轮次级 promptVersion）。这条直接决定 A-3 的实现形态，是当前唯一的硬分叉。
