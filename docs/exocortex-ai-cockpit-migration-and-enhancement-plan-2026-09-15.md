# Exocortex AI 驾驶舱迁移与增强开发方案

> 版本：`ai-cockpit-exocortex-plan@1.0`  
> 日期：2026-09-15（Asia/Shanghai）  
> 性质：从 StudyJournal 冻结基线迁移到独立 Exocortex 仓库的产品、架构、实施与验收方案。

## 0. 阅读说明（迁移基线）

用户提供的两份桌面报告是**评估材料，不是开发指令**。本方案综合：

- `AI 驾驶舱（生产版 Review Coach）产品与学习效果评估报告.md`：审计口径，强调工程实现与学习效果证明之间的差距。
- `AI 驾驶舱（生产版 Review Coach）产品与学习效果评估报告-Codex版.md`：产品口径，补充场景矩阵、目标架构、Evidence 协议和三个月路线。
- 当前源码、`AGENTS.md`、`docs/新的方案.md`、`docs/studyjournal-final-freeze-2026-09-15.md` 和 `docs/knowledge-base-evolution-blueprint.md`：作为当前事实基线。

报告中的 `175` 个确定性 Vitest 文件 / `1108` 项测试是评估时点数字；冻结记录中的最新收口基线为 `176` 个文件 / `1117` 项确定性测试，另有 Playwright `53` 通过、`1` 平台跳过和 Firebase Emulator `4/4`。这是验证时点不同，不改变产品判断。

## 1. 执行摘要

### 1.1 当前产品的准确定位

StudyJournal 当前的 AI 驾驶舱已经是一个**工程事实链成熟、学习决策链部分成立的“基于决策块的主动回忆与短期延迟验证助教”**。它能围绕已有笔记重点完成：反馈记录、AI 整理、深度分析、局部训练计划、题目生成、作答、即时评估和一次短期验证。

但它还不是：

- 跨学科考试规划器；
- 完整的个人学习操作系统；
- 编程项目或代码独立完成验收器；
- 申论、证明、系统设计等开放能力的可靠评估器；
- 能用系统内答题替代真实考试、项目和外部表现的学习效果证明系统。

### 1.2 Exocortex 应达到的下一阶段

Exocortex 不应只是复制 Review Coach 或继续增加题型，而应把它升级为：

> **以个人目标为牵引、以知识网络为上下文、以可验证学习任务为执行单位、以证据与校准为反馈的个人学习操作内核。**

优先补齐四层：

1. `Goal / Constraint / Capacity`：目标、时间、资源、截止日和计划恢复。
2. `LearningTask / Attempt / Evidence`：跨场景任务、真实尝试、产物和证据。
3. `Competency / Calibration / Recommendation`：多维能力、主客观校准和可解释推荐。
4. `Retrieval / KnowledgeGraph`：先做确定性检索，再激活用户确认的知识网络，最后驱动先修、交错、补漏和迁移。

### 1.3 StudyJournal 的迁移边界

- StudyJournal 在 2026-09-15 进入维护冻结，不在原仓库内改名或继续扩展产品。
- StudyJournal 的品牌、包名、应用标识、签名兼容性、数据目录和现有同步/备份边界保持不变。
- Exocortex 在新的本地目录和新的远端仓库启动。
- 数据只能通过显式、版本化、可回滚的导入器迁移，不能直接读取或静默改写旧应用数据库目录。

## 2. 当前 AI 驾驶舱现状

### 2.1 已成立的事实链

```text
记录正文
  -> DecisionBlock
  -> 块级真实反馈
  -> FeedbackInterpretation
  -> 用户确认分析范围
  -> SessionBlueprint
  -> AdaptiveReviewTask
  -> AdaptiveQuizTurn / 提示 / 作答 / 评估
  -> TaskOutcomeEvent
  -> DelayedVerification
  -> replay 投影
  -> 有限的客观效果字段回流下一次规划
```

关键实现位置：`src/features/reviewCoach/domain.ts`、`repository.ts`、`orchestrator.ts`、`replay.ts`、`sessionPlanningGateway.ts`、`quizExecutionGateway.ts`、`verificationPolicy.ts`、`ReviewCoachWorkbench.tsx`、`AdaptiveReviewPage.tsx` 和 `src/services/cloudSyncModel.ts`。

### 2.2 当前最值得保留的优势

1. **正式事实与派生投影分离。** 原始反馈、解释、蓝图、任务、轮次、结果和验证是事实；状态与效果是可 replay 的投影。这是后续能力扩展最重要的地基。
2. **内容唯一真源和版本失效。** `RecordBlock.contentHtml` 是可编辑内容源；`DecisionBlock` 只保存身份、索引和版本。内容变更后，旧分析和任务可失效，避免对过期材料训练。
3. **用户参与关键认知动作。** 用户选择重点、写困惑、实际作答并确认结果，AI 不能代替这些动作。
4. **AI 护栏和隐私边界完整。** JSON-only、schema、`insufficient-context`、答案泄漏检查、token 预算、幂等、超时、Provider 凭据本地化和导出剥离都已形成范式。
5. **任务状态和调度有真实语义。** 当前/等待/延期/无效/放弃/恢复以及验证优先级已经存在，不是简单的聊天记录。
6. **效果数据开始分层。** 自评、即时 AI 评估、延迟验证、实际题型、提示级别和版本信息已经分开记录，规划器只接收受限的客观字段。
7. **验证纪律成熟。** 确定性测试、E2E、Emulator、构建和设备门禁被分层；没有把 preview、配置或一次测试冒充生产能力和学习效果。

### 2.3 学习效果和场景适配的主要缺口

#### A. 没有真实目标、容量和计划恢复

`examDate` 主要是倒计时，不是调度约束。当前系统不理解多科目标、成功标准、可用时间、截止日风险、每周容量或计划失败后的局部重排。因此它适合“针对已有重点复习”，不适合托管考研、考公、长期学习或短期冲刺。

#### B. 任务模型仍偏向单块文本问答

七类 `AdaptivePracticeType` 能覆盖概念、计算、辨析、完形、变式、分块训练和先修检查，但核心仍是围绕单个决策块的多轮文字训练。`SessionBlueprint` 的初始难度、预期关键点、禁止范围、重试和 token 上限等字段并未全部转化为确定性执行语义。

这不能自然表达整套限时题、代码编译测试、项目里程碑、实验复现、证明检查或真实面试。

#### C. 系统内表现不能代表长期保持和迁移

块级验证目前主要是一次 `6–72h` 范围内的短窗。它能提供“短期新问题回忆”的信号，但不能替代数周/数月保持、真实套卷、项目交付、代码独立完成或系统外成绩。

#### D. AI 判题可污染后续决策，纠错权不足

所谓客观结果仍主要依赖 AI。题目、答案标准或判题有误时，用户可以报告坏题，但缺少完整的争议、用户覆盖、人工复核和 superseding correction 事件链。错误结果进入 replay 后可能继续影响验证和规划。

#### E. 开放题质量门不一致

本地泄漏检查是有效护栏，但开放题通常没有与计算题等价的独立题质审查，存在歧义、超纲、判据不足、暗含答案和不可判定的问题。

#### F. 效果样本和 regime 仍不足以支持强个性化

同一任务多轮回答可能过早形成“可用”样本；`unreliable`、题目质量、评估器和 prompt regime 的独立性也需要更严格处理。当前效果更适合作为探索性信号，而不是因果结论。

#### G. 校准信号没有完整呈现

自评和客观结果分开保存是正确的，但 UI 仍主要展示自评保持数字。用户看不到“我觉得会了”和“独立检索实际表现”的偏差，元认知校准收益被浪费。

#### H. 错因颗粒度不足

`correct / partial / incorrect / unreliable` 不能稳定区分概念缺口、先修缺口、易混淆、程序步骤、计算、读题、表达、速度、提示依赖、环境失败和独立性问题，导致后续训练不够针对。

#### I. 知识关系尚未参与决策

`knowledgePoints`、`knowledgeRelations`、`recordKnowledgePointLinks` 是知识图谱雏形，但 schema 19 后主要作为旧的确认事实保留，不能视为已上线的图谱产品。先修、相似、易混淆和跨主题关系还没有稳定驱动召回、交错和迁移。

### 2.4 多场景判断

| 场景 | 当前适配结论 | 主要可用价值 | 关键缺口 |
| --- | --- | --- | --- |
| 考研知识型科目 | 有条件适合 | 笔记重点主动回忆、解释、短期验证 | 无完整科目计划和长期迁移 |
| 考研数学/专业课 | 适合作为辅助 | 概念、计算、辨析和局部错因 | 过程证明、纸笔步骤、人工复核、真题环境 |
| 考公常识 | 局部适合 | 知识补漏和短答训练 | 行测速度、题型分布、整卷节奏 |
| 考公申论 | 不适合做主系统 | 观点和表达练习入口 | 长文 rubric、限时、标准/人工复核 |
| 自学编程入门 | 概念巩固适合 | 解释、先修检查、口述回忆 | 无代码运行、测试和调试轨迹 |
| 独立编程项目 | 不适合托管 | 项目知识反思 | 无里程碑、仓库、测试和交付验收 |
| 数据结构/算法 | 辅助适合 | 复杂度、辨析、变式 | 缺真实代码执行和独立解题证据 |
| CS 系统课程 | 局部适合 | 概念网络和口述 | 缺实验、源码、复现和报告证据 |
| 理论 CS/证明 | 低适配 | 定义和思路回忆 | 证明正确性不能只靠通用 AI |
| 面试/技术表达 | 局部适合 | 追问、提示、口述练习 | 缺真实面试环境和稳定评分 |
| 长期碎片化自学 | 有条件适合 | 低启动成本、持久化、恢复 | 缺容量、积压恢复、目标进度 |
| 截止日冲刺 | 当前不适合主导 | 局部重点复习 | 截止日不参与真实调度，无整卷模拟 |

**结论：**同一事实链可以承载多场景，但不能把同一个文本问答页面伪装成所有场景。

## 3. Exocortex 目标产品

### 3.1 四层能力

```text
L4 目标与操作层：Goal / Constraint / Capacity / Plan / Recommendation / Recovery
L3 任务与证据层：LearningTask / Attempt / Artifact / Evaluation / Evidence / Calibration
L2 知识与检索层：ContentUnit / Search / KnowledgeNode / Relation / Provenance
L1 迁移基础层：Record / DecisionBlock / Feedback / Blueprint / Task / Turn / Verification / Replay
```

### 3.2 首期参考场景

首期用差异最大的两个场景验证抽象：

- **知识型考试复习包**：目标、章节、限时小题、小卷、短答和延迟验证。
- **编程学习包**：代码输入、编译/测试、错误日志、修复尝试和独立完成标记。

申论、证明、系统实验、项目交付和面试，应在统一协议经这两个场景验证后再加入，避免范围爆炸。

## 4. 迁移原则

### 4.1 继承的工程纪律

1. 内容保留唯一可编辑真源，DecisionBlock 是一种内容来源，不复制正文。
2. 正式事实、AI 候选和派生投影分离；投影由 replay 重建。
3. AI 只能产出候选、解释、题目、rubric 草案和评分建议，不能直接生成不可纠正的长期事实。
4. 事实携带稳定 ID、版本、幂等键、墓碑、来源和冲突策略。
5. 确定性代码负责状态机、容量、截止日、证据门槛、独立性、隐私、同步、备份和推荐原因码。
6. 预览、配置、类型定义和确定性 UI 测试不能证明 Provider 能力或学习效果。
7. `unreliable` 不进入错误、掌握或效果分母；效果数字必须带样本、窗口、独立性和不确定性。

### 4.2 不复制的限制

- 不把单一 DecisionBlock 作为所有未来学习任务的唯一粒度。
- 不把 SessionBlueprint 当成全局长期计划。
- 不把自评保持率当成唯一用户可见效果。
- 不用一次短窗验证代表长期掌握。
- 不允许错误 AI 判题永久污染事实链。
- 不把旧 knowledge* 表直接当作可信自动知识图谱。
- 不以题型数量代替真实多场景适配。

### 4.3 迁移导入流程

```text
StudyJournal 导出包
  -> 格式、版本、hash、资产完整性检查
  -> 只读预览和迁移范围选择
  -> 分批事务写入 Exocortex
  -> replay / 搜索索引 / 关系候选重建
  -> 导入报告、回滚点和可重试状态
```

导入器必须再次剥离 Provider 密钥、raw response 和不应迁移的本地私密数据；不能直接打开旧数据库目录，也不能静默占用旧应用的数据目录。

## 5. Exocortex 目标架构

### 5.1 核心领域对象

| 层 | 对象 | 职责 |
| --- | --- | --- |
| 内容 | `ContentUnit`、`ContentSource` | 可检索、可引用、可关联的内容；DecisionBlock 是一种来源 |
| 知识 | `KnowledgeNode`、`KnowledgeRelation`、`ContentKnowledgeLink` | 概念、主题、方法、错误模式及关系；必须有 provenance |
| 目标 | `Goal`、`Milestone`、`ScopeItem`、`Constraint`、`CapacityWindow` | 成功标准、范围、时间和资源约束 |
| 计划 | `PlanRevision`、`RecommendationDecision` | 输入快照、候选、选中项、拒绝原因和策略版本 |
| 任务 | `LearningTask`、`TaskAdapter`、`Attempt`、`Artifact` | 真实执行，不只保存最终文本 |
| 证据 | `Evaluation`、`Evidence`、`ErrorAttribution`、`CalibrationObservation`、`ExternalPerformance` | 评价来源、可靠性、独立性、错因和系统外表现 |
| 能力 | `CompetencyState`、`InterventionAssignment` | 多维、带来源和置信度的可重建投影；区分观察和实验 |

### 5.2 六维能力状态

首期至少区分：`retention`、`conceptualUnderstanding`、`proceduralFluency`、`transfer`、`performance`、`independence`。每维必须携带 `confidence`、`evidenceCount`、`lastObservedAt`、`sourceMix`、适用范围和 replay 版本；不输出脱离证据的“83% 掌握度”。

### 5.3 AI 与确定性边界

| 领域 | AI 可以做 | 确定性代码必须做 |
| --- | --- | --- |
| 内容 | 摘要、候选概念、候选关系、反馈解释 | 来源、版本、确认和引用校验 |
| 题目 | 题干、变式、提示、rubric 草案 | 泄漏、范围、难度、预算、重生 |
| 评估 | 开放答案评分建议和不确定性 | 规则/测试优先、纠错、覆盖、证据门 |
| 规划 | 局部策略候选 | 目标、容量、截止日、优先级、冲突 |
| 图谱 | 节点和关系候选 | 去重、孤儿边、生命周期、用户确认 |
| 个性化 | 策略变体 | episode 门槛、污染检查、实验分配、停止规则 |

### 5.4 事件流

```text
Goal + Constraint + Knowledge Context
  -> 确定性候选选择
  -> RecommendationDecision
  -> LearningTask
  -> Attempt / Artifact
  -> Evaluation
  -> Evidence
  -> CompetencyState replay
  -> Calibration / PlanRevision
  -> 下一次 RecommendationDecision
```

## 6. 分阶段迁移与增强

### 阶段 0：新仓库基线（第 1–2 周）

- 决定新仓库所有者、名称、可见性、npm 包名、Android application ID、Electron app ID、显示名、协议名和新签名策略。
- 建立产品边界、数据语义、导入格式和发布门文档。
- 空数据启动；StudyJournal 独立运行；密钥和服务账号不进 Git。

### 阶段 1：迁移器与事实兼容层（第 3–6 周）

- 导入 `RecordBlock`、`DecisionBlock`、反馈、解释、蓝图、任务、轮次、结果和验证历史。
- 旧 Coach 任务映射为 `RecallTaskAdapter`，旧效果只作为可重算历史投影。
- 旧 `knowledgePoints` / relation 导入为 `LegacyKnowledgeSeed`，默认只读。
- 导入后执行 replay、完整性校验、索引重建和对照报告。

### 阶段 2：可信度闭环（第 7–10 周）

- 增加 `AssessmentDispute`、`AssessmentCorrection`、`HumanOverride`；AI 评估只被 supersede，不被静默删除。
- 单独处理 `unreliable`，不得进入错误、掌握和策略样本分母。
- 将效果样本提升为跨任务、跨日期的独立 episode；混合完整 prompt/schema/policy/question-quality/evaluator/adapter regime fingerprint。
- 提高 objective evidence 门槛；开放题统一检查范围、泄漏、可判定性、判据覆盖和材料证据。
- 题目失败只局部作废或重生，不默认终止整个任务。
- UI 同时呈现自评、客观观察、样本量、验证窗口和校准偏差。

**完成标准：**错误判题可纠正；单任务不能制造可靠策略效果；开放题质量事件可追踪；历史 replay 有版本迁移测试。

### 阶段 3：目标、容量和计划恢复（第 11–14 周）

最小链路：

```text
Goal -> Milestone -> ScopeItem -> CapacityWindow -> PlanRevision -> RecommendationDecision -> LearningTask
```

支持 `exam`、`skill`、`project` 三类目标；容量包含分钟、任务数、认知负荷、预算和设备限制。确定性策略先做可行性筛选，AI 只提出局部训练方案。延期、积压和失败必须能够降载、合并、冻结低价值任务并局部重排。

**完成标准：**计划容量违规率为零；用户能看到推荐理由和候选拒绝原因；延期后可恢复；旧 RecallTask 仍可执行。

### 阶段 4：统一任务—尝试—证据（第 15–20 周）

首批 adapter：

1. `RecallTaskAdapter`：继承主动回忆、提示、短答和验证。
2. `TimedQuizAdapter`：限时小题/小卷、题序、耗时、跳过、分值和能力维度。
3. `CodeTestAdapter`：代码提交、编译/测试、错误日志、修复尝试和独立性。

所有 adapter 统一写入 `Attempt`、`Artifact`、`Evaluation` 和 `Evidence`。规则/测试、AI、用户和人工来源分开；AI 生成的代码或答案不能计为独立完成证据。

### 阶段 5：能力、错因和推荐解释（第 21–26 周）

- 建立概念、先修、易混淆、程序、计算、读题、表达、速度、工具和环境等错因 taxonomy。
- AI 只提出错因候选；用户或规则确认后进入能力投影。
- 推荐使用稳定 reason codes：`due-verification`、`prerequisite-gap`、`repeated-error`、`low-independence`、`deadline-risk`、`capacity-fit`。
- UI 默认只显示最重要的一个差距和一句理由，避免统计淹没行动。

### 阶段 6：长期验证和受控个性化（第 27–36 周）

- 增加短期、数日、数周的递增验证窗口；每次要求新问题或真实任务。
- 明确与记录级 FSRS 的桥接/隔离契约，不隐式创建第二套复习真相。
- 接入 `ExternalPerformance`：模考、测试、项目验收、实验结果和人工评分。
- 仅在用户同意时开展 learner 内策略比较，记录基线、分配、污染、退出和停止规则。

## 7. 检索与知识图谱路线

知识图谱必须服务于三个问题：“相关内容在哪里”“困难是否来自先修/易混淆关系”“下一项任务如何交错和迁移”，而不是先做装饰性的关系图。

### G0：确定性检索底座（约第 11–16 周）

- 新增本地、可重建的 `searchIndex`，覆盖标题、正文、标签、决策块和反馈。
- 中文用稳定的 n-gram / 轻量分词；不把搜索正确性绑定外部服务。
- 编辑、删除、导入后增量更新，启动时可全量重建。
- 结果按记录、内容单元、标签和候选概念聚合。
- 索引不进云同步和备份。

验收：千条记录常用查询低于 100ms；编辑/删除/导入后一致；索引损坏可自动重建。

### G1：语义召回（G0 稳定后，约第 17–24 周）

- 定义可替换的 embedding provider interface。
- 向量绑定 `contentVersion`、模型版本和生成时间；默认本地派生、不同步、不备份。
- 语义失败时回退倒排检索。
- 分别验证中文、公式、代码和长文召回质量。

用途是为 Review Coach 找相关内容、为用户召回相似/易混淆/历史错误、为 AI 上下文预算排序候选，而不是把整库塞进 prompt。

### G2：激活知识节点和关系（约第 25–32 周）

新 `KnowledgeNode` 必须有候选、确认、存档、合并和拒绝生命周期。节点类型可包括概念、主题、方法、公式、术语、错误模式、项目能力和来源；关系包括 `prerequisite`、`part-of`、`similar`、`confusable`、`example-of`、`transfer-to` 和 `contradicts`。

AI 输出 `KnowledgeProposal`，必须展示来源摘录、版本和置信度，经用户确认/修改/拒绝后才成为正式事实。补齐去重、合并、孤儿边、逆向关系和跨实体校验。旧知识点作为只读种子，不自动升级。

### G3：图谱驱动学习决策（第 33 周以后）

- `prerequisite-gap`：失败时检查未验证的前置节点。
- `confusable-interleave`：在相似概念之间安排对比题。
- `graph-context-recall`：在目标、容量和 token 预算内扩展相关上下文。
- `transfer-path`：从概念链接到限时、代码、项目或口述任务。
- 图谱驱动的任务结果只更新能力证据，不直接修改关系事实。

图谱失效必须回退到倒排检索和现有 Review Coach；每个推荐都要说明使用了哪条关系。

### 7.1 数据边界

| 数据 | 云同步 | 备份 | 可重建 |
| --- | --- | --- | --- |
| 用户确认的知识节点/关系 | 是 | 是 | 否 |
| AI 候选关系 | 产品决定；默认可审计候选 | 可导出 | 可重算 |
| `searchIndex` | 否 | 否 | 是 |
| embedding / 图谱布局缓存 | 否 | 否 | 是 |
| prompt、raw response、Provider key | 否 | 否 | 否，按隐私策略剥离 |

## 8. 产品交互

### 8.1 今日驾驶舱

优先展示：目标与今日容量、一个最值得开始的任务、一句推荐理由、待验证证据、截止日/积压风险。不要把 AI 调用量、题目数、完成数或单一掌握度总分作为主 KPI。

### 8.2 任务页面

按 adapter 呈现，而不是所有任务同一 textarea：回忆任务保留提示阶梯；限时任务显示时间、分值和整卷语义；代码任务显示测试和错误日志；开放任务显示 rubric、证据、不确定性和争议入口。

### 8.3 结果页面

明确展示完成内容、提示/工具/AI 介入、规则/测试与 AI 结果来源、即时表现、延迟验证、自评—客观差异、下一步理由和证据不足项。

### 8.4 图谱页面

以问题为中心，而不是以力导向图为中心：来源是什么、相关内容在哪里、前置缺口是什么、哪些概念易混淆、哪个任务可以验证关系。图形只做导航，节点详情和证据才是核心。

## 9. 验收指标与发布门

### 9.1 学习结果

- 即时客观表现：有效、可判定、非 `unreliable` 的规则/工具/AI 观察。
- 延迟保持：多个时间窗的新问题或新任务表现。
- 校准差：自评预测与客观/延迟观察差异，两者不合并。
- 迁移表现：新情境、限时、代码或外部任务表现。
- 独立完成率：明确提示、AI、工具和环境介入后计算。

每项都必须带来源、窗口、样本、独立性、适用范围和不确定性；不能把同材料换措辞当作真实迁移。

### 9.2 规划、AI 和长期使用

- 规划容量违规率、推荐采纳后完成率、延期恢复率、截止日风险召回率。
- schema 失败率、泄漏率、重生率、`unreliable` 比例、AI/人工一致性、纠正率、预算违规率。
- 30/60/90 日有效验证、递增验证到达率、积压恢复率、错因复发率和提示依赖变化。

### 9.3 分层发布门

1. 确定性门：schema、状态机、replay、版本、幂等、导入回滚、同步、备份。
2. AI 机制门：受控 Provider、题质、判题一致性、费用和超时。
3. 设备门：Desktop、Android 窄屏、键盘/IME、前后台、音频和系统返回。
4. 真实任务门：限时题、代码测试、外部结果导入、人工复核。
5. 学习效果门：至少一个场景的多时点保持、迁移或外部表现证据。

任何一层未通过，只能声称对应层级能力，不能用自动化 UI 测试替代学习效果证明。

## 10. 风险控制

| 风险 | 控制 |
| --- | --- |
| 原地改名破坏旧应用 | 新仓库、目录、标识、签名和显式导入 |
| 双重内容真相源 | 复用内容单元；知识节点保存语义与来源，不复制正文 |
| AI 污染长期状态 | candidate/confirmed、correction、supersede、replay |
| 统计伪个性化 | episode 门槛、完整 regime fingerprint、保守置信度 |
| 图谱自动建错 | 候选→确认、来源、置信度、逆向一致性 |
| 计划复杂度过高 | 最小字段、渐进补充、确定性容量、局部恢复 |
| embedding 供应商锁定 | provider interface、倒排回退、本地派生 |
| 隐私泄露 | 实体级同步/备份边界和导出回归测试 |
| 范围爆炸 | 先用知识型考试和代码测试两个参考场景 |

## 11. 近期产品决策

Exocortex 编码前需要一次性确认：

1. 新仓库所有者、名称、可见性、包名和应用标识。
2. 新签名密钥、数据目录和 Provider 凭据策略。
3. 迁移全部数据，还是只迁移记录、决策块和 Coach 历史。
4. 首期参考场景是否确定为知识型考试和代码测试。
5. 知识节点、确认关系和候选关系的云同步/备份边界。
6. embedding 是否默认关闭，以及本地/远端模型选择。
7. 开放答案争议由用户确认、人工复核还是预留教师接口。
8. 真实 Provider、设备和学习者实验的预算与批准流程。

## 12. 最终建议

推荐顺序：

```text
事实可信度与纠错
  -> 目标 / 容量 / 计划恢复
  -> 任务 / 尝试 / 证据统一协议
  -> 限时题 + 代码测试验证多场景抽象
  -> 确定性检索
  -> 用户确认的知识网络
  -> 图谱驱动召回、先修、交错和迁移
  -> 受控长期个性化
```

最重要的取舍是：**宁可少承诺、少自动化，也不要把 AI 生成的题目、判题、关系和统计包装成真实学习效果。** StudyJournal 已经提供了可迁移的工程底座；Exocortex 的新增价值应来自目标、容量、可纠正证据、真实任务、检索和知识网络，而不是更多孤立的 AI 页面。

## 附录：证据索引与不确定性

- 产品闭环和边界：`docs/新的方案.md`。
- 实体、状态和结果：`src/features/reviewCoach/domain.ts`。
- 规划输入与客观效果字段：`src/features/reviewCoach/sessionPlanningGateway.ts`。
- 生成、质检、评估、验证和调度：`src/features/reviewCoach/orchestrator.ts`、`verificationPolicy.ts`。
- effect replay 和 strategy key：`src/features/reviewCoach/replay.ts`。
- 正式事实事务和版本失效：`src/features/reviewCoach/repository.ts`。
- 工作台展示和 replan：`src/features/reviewCoach/ReviewCoachWorkbench.tsx`。
- 云同步实体：`src/services/cloudSyncModel.ts`。
- 旧知识网络边界：`src/db/reviewCoachSchema.ts`、`docs/knowledge-base-evolution-blueprint.md`。
- 冻结与 Exocortex 分离规则：`AGENTS.md`、`docs/studyjournal-final-freeze-2026-09-15.md`。

以下事项仍必须通过独立证据验证：真实 Provider 的 AI/人工一致性；多时点验证的长期收益；语音和代码任务的学习增益；图谱关系准确率及其对任务收益的增量；30/60/90 日留存与积压恢复。没有这些证据时，对外只能说“辅助复习、证据驱动、可纠正、逐步验证”，不能说“自动掌握、可靠预测成绩或替代教师”。
