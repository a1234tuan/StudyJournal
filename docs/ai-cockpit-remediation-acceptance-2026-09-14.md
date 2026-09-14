# AI 驾驶舱学习效果修复 · P4 验收记录

> 日期：2026-09-14
> 范围：批次 A + B + C（共 11 条发现），按 `docs/ai-cockpit-data-semantics-pre-stage-2026-09-14.md` §5 的 P0 → P1 → P2 → P3 → P4 顺序执行。
> 结论：**本地验收全部通过；唯一未关闭的门是付费 Provider 验收**（需要 API Key，命令见 §6）。

---

## 1. 每阶段的验证方式与结果

| 阶段 | 内容 | 验证方式 | 结果 |
| --- | --- | --- | --- |
| P0 | 语义契约 | 文档确认（你已确认 A-2/A-3 保留 + §2.5 选项 (i)） | 完成 |
| P1 | A-1 / A-2 / A-3 | 定向测试 + 全量回归 + `tsc -b` + `npm run build` | 22 文件 / 127 项 → 全绿；全量 173 文件 / 1088 项 0 失败；build 成功 |
| P2 | B-1 / B-2 / B-3 | 同上 | 22 文件 / 129 项全绿；全量 173 文件 / 1088 项 0 失败；build 成功 |
| P3 | C-1 / C-1b / C-2 / C-3 / C-4 / C-5 | 同上 + 新增 6 个测试文件 | 全量 **175 文件 / 1108 项通过，0 失败**（3 项 live 跳过）；build 成功 |
| P4 | 验收记录 + 基线更新 | 本文档 + AGENTS.md | 见 §6 |

最终状态：`npx tsc -b` 0 错误；`npm run test` → **Test Files 175 passed \| 3 skipped、Tests 1108 passed \| 3 skipped、0 失败**（3 项 skipped 为付费 live 测试）；`npm run build` 成功。

---

## 2. 各批次的落地情况与验收测试

### 批次 A：让效果可度量

- **A-1（F-18）**：`SubmitQuizAnswerInput.decisionBlockContent` 必填；`useAppData` 构造单决策块上下文包并经 `assertTurnContextBudget` 校验后传入 `evaluateAnswer`；评估器指令明确"判据可能不准，冲突须判 `unreliable`"，`maxTokens` 1000 → 1400。
- **A-2（F-18/F-02）**：`InterventionEffectSummary` 新增客观字段；**`evidenceStatus`（自评门槛）语义一行未改**，界面零改动（D-1(b)）。验收测试 `replay.effectMetrics.test.ts`（5 项）覆盖：客观率 1/3 与末轮判定分布、客观/自评两个门槛互不影响（D-1 护栏）、`unreliable` 不进分母、`retentionRate` 与 `verificationObjectiveCorrectRate` 不混同、顺序无关。
- **A-3（F-14）**：`strategyKey` 追加 `actualPracticeType` + `hintLevelUsed` + 排序后的轮次级 `promptVersion` 集合（§2.5 选项 (i)）；`averageTurnsToMastery` 排除 `[skipped]` 轮。验收测试 `replay.strategyKey.test.ts`（5 项）。

**A-3 引出的真实缺陷（新测试抓到并已修复）**：`replayFingerprint` 是内容哈希，但把输入数组顺序也算进去了，违反顺序无关约束。已改为对 `blueprints/tasks/outcomes/verifications/turns` 排序后再哈希；末轮判题的比较器改为 `(occurredAt, turn.sequence, id)` 字典序（§2.4 约束 2）。

### 批次 B：让结论能回流

- **B-1（F-08）**：投影状态由"后写覆盖前写"改为显式优先级：`stale → learning → needs-analysis（新反馈未被处理）→ 内容事件 → planned 兜底`。既有 4 处断言（`repository.test.ts`）逐一核对，未破坏。新增 `replay.projection.test.ts`（5 项）。
- **B-2（F-01）**：`planSession` 新增 `interventionEffects`，**只含客观字段**，绝不携带 `retentionRate` / `selfReportedMasteredCount`；效果摘要按 `objectiveEvidenceStatus === "usable"` 门槛过滤、按主块 `difficultyType` 圈定范围、上限 5 条；并纳入 `inputFingerprint`，使"这批分析用了哪份证据"可审计。
  - **对原方案的一处修正**：方案 §3 B-2 写的是按 `evidenceStatus`（自评门槛）过滤，这与 D-1 契约第 3 条（"客观不因自评缺失而消失"）自相矛盾。已按已批准的契约改为客观门槛，并在代码注释与本记录中登记。
- **B-3（F-03）**：`listDecayedBlocksNeedingReplan` 派生查询（不写任何正式事实）；工作台新增"需要重新规划"区块，说明文本走**用户自撰评论**路径（`recordFeedback`，`source: "manual"`），不产生任何系统代笔的正式事实。
  - **对原方案的一处修正**：方案要求把说明写进 `AnalysisQueueItem.analysisNote`，但衰退块按定义**还没有队列项**，`updateQueueItemAnalysisNote` 无从落笔。改为把说明直接作为用户评论（同为同步字段、同样无契约变更），少一次写、少一次查询。

### 批次 C：让用户真的拿到练习，且证据不被污染

- **C-1（F-17）**：`AiCompletionRequestOptions.systemPrompt`；默认 `SYSTEM_PROMPT` 改名 `CHAT_SYSTEM_PROMPT` 并导出；三个驾驶舱网关 + 知识播客统一传入 `REVIEW_COACH_ROLE_SYSTEM_PROMPT`。不传即回退默认，普通问答行为不变。
  - 测试修正：方案要求断言 system 消息"不含 Markdown"，但角色提示词本身必须包含"**不要** Markdown"这一否定指令。断言已改为"不得要求 Markdown/LaTeX/来源清单，必须禁止 Markdown"，语义等价且可执行。
- **C-1b（F-21）**：`knowledgePodcastService.ts` 新增 `PODCAST_SCRIPT_SYSTEM_PROMPT`（定义在 services 层，避免反向依赖 features）。
- **C-2（F-04/F-07）**：出题提示词的枚举由解析器同源常量 `quizPracticeTypes` / `answerModes` 生成（旧文案 6 个值里 3 个非法）；`requestedStrategy` 与 `initialPracticeType` 拆开，首轮不传该字段。测试断言提示词中的取值集合与解析器**严格相等**。
- **C-3（F-06）**：`unreliable` 评价带显式 `unreliable:` 前缀写入既有 `TaskOutcomeEvent.reason`（不改 schema），不选择 `partial` 分支策略、不推进难度、不产生掌握判定。UI 既有文案"无法可靠判断"已覆盖用户提示。
  - **对原方案的一处修正**：方案第 3 条要求"在更完整的材料下重判一次"。A-1 落地后评估器**已经**拿到完整决策块材料，对同一输入做第二次重判只会重复付费、结果大概率相同，故**未实现盲重试**，只保留显式记录 + 不驱动任何决策。登记为本记录的偏离项。
  - **登记的既有不一致**：`verificationPolicy.ts:33` 仍把 `unreliable` 与 `partial` 同档延后验证间隔——那是时间安排而非掌握判定，本轮不改。
- **C-4（F-20）**：`questionIntegrity.ts` 提供确定性本地泄漏检查（全角/空白/标点/大小写归一，判据 ≤2 字符静默跳过）；命中按既有"质检失败→重出一题"路径处理一次，第二次仍命中则抛可读错误，**不再调用**；`answer-leakage` 进入 `severeIssues` 枚举。
  - **实测抓到一处真实泄漏**：`stage7Orchestrator.test.ts` 旧 fixture 的第二轮题面"…marking before enqueue…"原文包含判据 `before enqueue`，被新检查正确拦截。已修正该 fixture（其测试目的与题面文本无关）。
- **C-5（F-19）**：`validateBlueprintCandidates` 的 feedback / interpretation / evidence 允许集按 `allowCrossBlockSupport` 分别收敛；关闭支持时 evidence 必须全部来自主块。三个用例：跨块引用被拒、主块引用通过、显式开启支持时不误伤。

---

## 3. 明确不做 / 延后

| 项 | 理由 |
| --- | --- |
| 批次 D（批D-1～批D-5） | 按你确认的范围，本轮仅 A + B + C；D 项涉及产品边界（批D-5）与同步实体字段（批D-4） |
| P-1 投影写放大 / P-2 分模型 / P-3 策略落库 / P-4 更多维度 | 原方案 §6 已列延后理由 |
| 跨设备时间裁决 | §2.4 明确本轮不做，列为未解决问题 |

---

## 4. 已知可见后果与风险（须告知，不隐瞒）

1. **A-3 分组变细 → 工作台效果列表变长变碎**：工作台仍取前 3 条（按 `strategyKey` 字典序），组数变多后可能出现"0 次样本"的空组与真实样本组并存，且每组的验证样本数变小、更易显示"验证样本较少"。这是已声明的统计口径变化，不是缺陷；若观感不佳，最小改法是把列表改为按 `sampleCount` 降序再截前 3（一行改动，需你拍板）。
2. **C-4 误杀风险**：本地检查只拦"判据原文出现"，但一道合法题目确实可能复述判据短语；命中后只有一次重出机会，第二次仍命中会使该轮生成失败。判据 ≤2 字符已跳过，残余风险登记在案。
3. **C 批改变模型可见指令**：属于 AGENTS.md 定义的"受控真实 Provider 验收"范围 → 见 §6。
4. **投影回滚会改变用户看到的统计口径**（不是无风险），`REVIEW_COACH_REPLAY_VERSION` 已升至 v3，升级后强制重建一次。

---

## 5. 新增/修改文件清单

**新增源码**：`contextBudget.ts`、`rolePrompts.ts`、`questionIntegrity.ts`
**新增测试**：`contextBudget.test.ts`、`replay.effectMetrics.test.ts`、`replay.strategyKey.test.ts`、`replay.projection.test.ts`、`replay.replan.test.ts`、`questionIntegrity.test.ts`、`aiClientService.systemPrompt.test.ts`、`aiAcceptance.live.test.ts`（付费门控）
**修改源码**：`replay.ts`、`domain.ts`、`orchestrator.ts`、`quizExecutionGateway.ts`、`aiGateway.ts`、`sessionPlanningGateway.ts`、`analysisPlanner.ts`、`aiSchemas.ts`、`aiClientService.ts`、`knowledgePodcastService.ts`、`ReviewCoachWorkbench.tsx`、`useAppData.ts`、`ReviewPage.tsx`、`App.tsx`、`pages.css`
**修改测试**：`aiSchemas.test.ts`、`stage6Orchestrator.test.ts`、`stage7Orchestrator.test.ts`、`quizExecutionGateway.test.ts`、`orchestrator.test.ts`、`sessionPlanningGateway.test.ts`、`analysisPlanner.test.ts`、`ReviewCoachWorkbench.test.tsx`

---

## 6. 付费 Provider 验收（唯一未关闭的门）

已按最小样本写成门控 live 测试，**默认跳过，不影响确定性套件**：

```bash
REVIEW_COACH_LIVE_DEEPSEEK_KEY=sk-... \
npx vitest run src/features/reviewCoach/aiAcceptance.live.test.ts
```

- 成本上限：**2 次调用**（1 轮出题 + 1 次判题），约 2k 输入 / 1.8k 输出 token。
- 覆盖：C-1/F-17（角色提示词下能产出 schema 合法轮次）、C-2/F-04（枚举合法）、C-4/F-20（真实生成题通过本地泄漏检查 = 误杀探测）、A-1（评估器拿到材料并只引用既有判据）。
- 运行后请把结果（practiceType / answerMode / assessment / 是否命中泄漏 / 用量）追加到本文档 §7。

### 7. 付费验收结果

（待执行）
