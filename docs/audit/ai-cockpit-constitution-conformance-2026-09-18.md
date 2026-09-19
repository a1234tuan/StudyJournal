# AI 驾驶舱：学习设计宪法合规性核查（2026-09-18）

## 0. 一句话结论

**机制层高度合宪，启用层不合宪，证据层为零。**

- 机制层：驾驶舱的 v2 闭环几乎逐条落实了宪法第 1、2、6、7、8、9 条，合规度是本项目所有模块里最高的。
- 启用层：唯一合宪的那条流程被 `releaseGate` 关在门内（`PRODUCTION_V2_ENABLED = false`），**生产构建跑的是 v1 流程，而 v1 正是宪法要纠正的那套**。
- 证据层：**摩擦门从来没有真实数据**。埋点已接好、判据已写好，但从采到过 0 个真实会话。

核查基准：`D:\Exocortex\docs\design-constitution.md`（`design-constitution@2.0`，15 条）+ `D:\Exocortex\docs\exocortex-dev-plan-constitutional-2026-09-15.md`（M0–M5）+ `D:\Exocortex\docs\validation.md`（发布门）。
核查对象：`D:\StudyJournal-Source\src\features\reviewCoach\`。已确认 Exocortex 侧 `releaseGate.ts` 的开关值与 StudyJournal 一致，故下列结论对两个仓库同时成立。

---

## 1. 摩擦维度（第 3 条 + 第 14 条，本次重点）

### 1.1 判据本身是合宪的，且是可测量的

`frictionReport.ts:124`：

```ts
meetsOperationBudget: measuredSessions >= MIN_SESSIONS_FOR_OPERATION_BUDGET && rollup.operationRatio <= 0.15
```

- 阈值就是宪法第 3 条的 15%，不是另立口径。
- 分母用 `totalActiveMs`（三分段时间之和），分子只用 `operationMs`（`interactionTrace.ts:136-142`）。
- **样本下限的处理比宪法更严**：`MIN_SESSIONS_FOR_OPERATION_BUDGET = 10` 且按 `sessionId` 去重（`frictionReport.ts:87-91`），并明确排除 workbench 段（无 `taskId`）。`frictionReport.ts:37-52` 记录了为什么从"10 个 segment"改成"10 次 session"——因为一个会话能产出多个 segment，旧判据会让"开这个页面十次"就满足学习样本要求。这条自我纠正是合宪的。

### 1.2 记账口径正确，且空闲时间不被误计

`AdaptiveReviewPage.tsx:215-229` 的相位推导：

| 学习者此刻在做什么 | 记账类别 | 相位 |
| --- | --- | --- |
| 等 AI 生成（`busy`） | `operation` | `waiting-for-ai` |
| 阅读针对自己答案的反馈 | `feedback` | `feedback` |
| 答案已显示、正在作答 | `cognitive` | `initial-retrieval` / `post-judgment` / `delayed-*` |

- 宪法第 3 条要求"系统必须分别记录认知活动时间与非学习管理时间，不能把所有点击或停留时间混为一谈"——三分段严格分离，满足。
- `interactionTrace.ts:79-83` 的 `accruedMs` 在空闲边界裁剪时间：**"a tab left open overnight cannot turn into operation friction"**。页面隐藏与 60 秒空闲都不计时，满足"不把停留时间当摩擦"。
- 反馈时间计入分母、不计入分子（`feedback` 既非 operation 也非 cognitive），符合 dev plan §4.5 的定义，不算放水。
- 存储边界合宪：仅本地、保留 30 天、不存答案/页面文本/Prompt/Provider 响应，不进入 Firebase、ZIP、流式备份、native repository、record transfer、knowledge export（`interactionTrace.ts:14-17`）。
- **不进入学习者界面**，理由写在代码里：`frictionReport.ts:9-10` —— "it would become a fourth competing metric (constitution art. 14)"。

### 1.3 但摩擦门从未被测量 ❌

- `buildFrictionReport` 的**全部**调用点都在 `frictionReport.test.ts` 里，源码中没有任何生产或脚本调用点。
- `docs/`、`audit/`、Exocortex `validation.md` 中都**没有**任何真实会话的 `operationRatio` 数字。
- `AdaptiveReviewPage.tsx:201-213` 自己承认过这个缺口："The hook existed and was unit-tested but nothing in the product ever called it, so no session ever produced a segment and the 15% operation budget could never be evaluated on real data." —— 该注释所指的"已修"只到"埋点被接上"这一步，**报告从未跑过**。
- M5 的 Go 条件明确要求"10 次真实新流程会话 operation active time / total active time 不超过 15%"；`validation.md` 也明确说"deterministic unit and UI tests can verify enforcement mechanics but cannot establish the friction ratio"。

**判定：摩擦门 = 未测量，不是通过。** 这是本次核查最重要的一条——它不是代码缺陷，是证据缺失。

### 1.4 第 14 条（同屏最多一个学习效果指标）

- **驾驶舱内合规**：`ReviewCoachWorkbench.tsx:198-210` 只显示一个当前任务、一句原因、一个主动作；批量勾选、子批次数、token 数、跨块选择、"确认并开始"都已删除；多任务列表不同屏竞争。
- **驾驶舱外不合规**：见 §4.3。

---

## 2. 闭环与验证（第 1、2、8、9 条）

### 2.1 第 2 条：v2 分支满足，v1（线上）不满足 ❌

- 合宪的部分：`learningLoopPolicy.ts:18` 要求 `requiredQualifyingRetrievalsV2 = 2`，且 `COMPLETION_PHASES = ["initial", "post-judgment"]`（反馈前后各一次）；`AdaptiveReviewPage.tsx:382` 的按钮文案在 v2 下直接是"按这个方式再提取一次"；未闭合时只给"稍后再练"，**从不给"结束"**（`AdaptiveReviewPage.tsx:391-392`）。
- 不合宪的部分：`releaseGate.ts:28` `PRODUCTION_V2_ENABLED = false`；gate 的唯一使用点是 `orchestrator.ts:695`，仅在开启时才给蓝图盖 `loopVersion: closed-loop-v2`。
- 后果：生产构建的任务没有 `loopVersion`，于是 `AdaptiveReviewPage.tsx:401` 的 `finishing && answered && !isClosedLoopV2` 生效——**作答后可以直接"结束本次训练"，反馈后不强制再提取**。这正是 dev plan §2.2 冲突 #1。

### 2.2 第 8、9 条：合规度最高 ✅

`evidencePolicy.ts:322-341` 的 `verificationEvidenceStatusFor` 逐项设卡：

```ts
if (!turn || !isQualifyingRetrieval(turn)) return "ineligible";
if (turn.independenceStatus !== "independent") return "ineligible";
if (turn.variantEligibility !== undefined && turn.variantEligibility !== "eligible") return "ineligible";
if (turn.targetFormStatus !== undefined && turn.targetFormStatus !== "target-form") return "ineligible";
const authority = authorityOfTurn(turn);
if (authority === "none") return "ineligible";
if (authority === "objective") return correct ? "objective-pass" : "objective-fail";
return correct ? "provisional-pass" : "provisional-fail";
```

- **第 8 条"换说法不算会"**：独立 + 未见变式 + 目标形式三重门，任一项不满足直接 `ineligible`。`variantPolicy.ts:8` 还注明重复题"measures short-term familiarity, not retention"。
- **第 9 条"AI 没有最终判决权"**：`authority === "objective"` 才产生 `objective-pass/fail`，AI 独立判对只落 `provisional-*`；`durableConclusionOf` 只在 `hasDurableConclusion`（即 objective）时才给 `retained/decayed`；`continuesVerificationChain` 让 provisional 结果继续开后继验证（`evidencePolicy.ts:309-327`）。
- **坏题/错判可撤销**：`evidence-superseded` 是 append-only 撤销，不删原判（`evidencePolicy.ts:88-104`）；`validation.ts:86-96` 明确禁止该事件携带 assessment / disposition / subjective outcome。
- **§4.6 的诚实裁决**：本阶段不新增 `AnswerKey` 表、无高等级来源时 AI 判定"照常用于即时反馈和下一步动作，但不能产生最终关闭或永久免检状态"——与第 9 条一致，没有伪称标准答案。

### 2.3 第 1 条（提取优先）✅（在 v2 内）

`variantPolicy.ts` / `evidencePolicy.ts` 的存在本身就是"让用户提取"的产物；`AdaptiveReviewPage.tsx:171-172` 注明 v2 任务"the learner never sees 已掌握 / 仍需巩固 / 未掌握, because none of those is a fact they can report"。

---

## 3. 功能立法与 AI 边界（第 4、5、6、7、10、11 条）

### 3.1 第 6 条（分类触发不同动作）完全合规 ✅

`interventionPolicy.ts:53-57`：

| 用户语言 | 下一步动作 | 分支策略 |
| --- | --- | --- |
| 我没有想出来 | 回到材料重建这条规则，然后重新提取 | `rebuild` / `prerequisite-check` |
| 我记混了 | 把两条容易混淆的规则放在一起辨析 | `discriminate` / `explain` |
| 我会，但没写出来 | 再提取一次，要求写出完整表述 | `produce` / `continue` |

反自尊规则也落实了：`MAX_CONSECUTIVE_EXECUTION_FAILED = 2`，第三次被**系统降级**到 `not-formed` 且"not negotiable from the UI"；同时 `interventionOptionsFor` 把该选项显示为"不可用 + 解释"而不是静默隐藏（`interventionPolicy.ts:110-118, 128-140`）。降级是系统决定、不由用户确认，符合本条"用户选择的是行动路径，不是为系统确认因果诊断"。

### 3.2 第 7 条（手选替代确认）合规 ✅

- 选项是行动（"我没有想出来"），不是"请确认 AI 对你的错因判断是否正确"。
- `AdaptiveReviewPage.tsx:231-239` 注明：记录行动与请求下一次提取**是同一个用户动作**，"splitting them would add a confirmation step the constitution forbids"。
- 坏题纠正是一次动作（`AdaptiveReviewPage.tsx:436-441`），符合"一键指出坏题"。
- `validation.ts:86-96` 禁止事件形状混装，防止"自评"被写成"诊断真相"。

### 3.3 第 10 条（应用内 AI 受限职责）合规 ✅

`rolePrompts.ts` 的 `REVIEW_COACH_ROLE_SYSTEM_PROMPT` 写死了四条不可协商项：只输出 JSON；不得改变输入中的目标/来源/版本；**不得补造来源、改写用户原话或宣告用户已掌握**；信息不足时返回 `insufficient-context`，不要猜测。

与第 10 条的禁止清单逐条对应：不充当最终权威（不宣告掌握）、不代替用户提取、不产出不可纠正的长期事实（append-only 才可纠正）、不用流畅解释替代证据。

**唯一可补的**：未禁止"评价努力/思路很好"这类鼓励语言。第 10 条已禁止"用鼓励语言替代证据"，但只有"替代证据"被禁，鼓励语本身未被禁——这是可以补一句的位置（也是 ETHOS 06-4 明确要求写死的一条）。

### 3.4 第 4、5、11 条（流程性要求）符合 ✅

- 准入声明存在（dev plan §2.3）：真实场景、每周新增提取次数、保留/删除的摩擦、权威边界、用户可见效果，逐项有答案。
- 第 5 条：本阶段只服务"用户正在备考的知识型和计算型科目"，未引入第二场景抽象。
- 第 11 条：代码注释普遍把"为什么符合宪法"写在改动处（如 `AdaptiveReviewPage.tsx:386-388` 解释为什么验证页只渲染一个前进动作、`frictionReport.ts` 解释为什么不进 UI），符合"能用一句话说明它保护了哪条验证链"。

---

## 4. 数据法（第 12、13、15 条）——违规集中在驾驶舱之外

### 4.1 第 12 条（N=1，禁掌握度百分比）⚠️

`src/pages/StatsPage.tsx` 把 `masteryTrend[].rememberedRate` 聚合成百分比展示：

- `StatsPage.tsx:34`：`{Math.round(summary.rate * 100)}%`
- `StatsPage.tsx:75-76`："近 7 天回忆成功率" / "近 30 天回忆成功率"
- `StatsPage.tsx:92-93`：按日 `rememberedRate` 的百分比进度条

`rememberedRate` 来自 `RecordReviewStats.masteryTrend`（`src/types.ts:233`，由 `storageAdapter.ts:1567` 从记录级复习自评聚合）。它是**单人、稀疏、自评口径**的数字，用百分比 + 趋势条呈现，正是第 12 条"不得把少量事件升格为稳定能力属性""用平滑曲线制造精确可靠观感"所指的形态。变量名本身还叫 `masteryTrend`。

### 4.2 第 13 条（只呈现三类结果）⚠️

三类合法结果：①延迟未见变式通过率 ②同一错因是否复发 ③校准图。

- ①：`InterventionEffectSummary` 在源码里**没有任何 `.tsx` 使用点**（只有 replay 内部与测试），主界面不呈现它。这是"不违反"（不需要 ①也能合规），但也意味着宪法指定的唯一主效果数字未落地。
- ②**完全缺失**：`grep -rn "sameSpot|same_spot|复发|recurr|repeatedError|sameError" src/` **零命中**。这是唯一的"宪法已立法、ETHOS 也要求、代码里确实没有"的直接缺口，同时对应 dev plan §2.4 的"第三层延迟证据：同一错误是否复发"。
- ③**未实现**：`domain.ts:489` 自己注明校准只用内部，"a future UI decision"。
- 违规面：StatsPage 的"回忆成功率"**不属于**上述三类，却出现在学习者可见的效果区域。

### 4.3 第 14、15 条（注意力门 + 动机）❌

- **第 14 条**：`StatsPage.tsx` 同一屏渲染 6 张卡片中的 **2 个百分比 + 1 个 streak 天**（`StatsPage.tsx:64, 75, 76, 77`），"同屏最多突出一个学习效果指标"被打破。
- **第 15 条**：明确"不做打卡、连击、徽章、虚拟奖励"。
  - `StatsPage.tsx:77` 显示"连续复习 {streakDays} 天"；`DailyPlanPage.tsx:417` 同样显示。
  - `src/components/Heatmap.tsx:19` 的 `aria-label` 就是 **"打卡热力图"**。
  - 缓解事实：StatsPage 自己写了"仅表示复习连续性，不代表学习质量"，`DailyPlanPage.tsx:35` 也注明派生值来自正式事实。但第 15 条是**以机制本身为禁止对象**（"不作打卡、连击"），不是"不可宣称质量"，所以这是形态违规而非文案问题。`validation.md` 的发布门原文也写着 "no streak, badge, activity count, mastery percentage ... is presented as progress"。

---

## 5. 第六章发布门逐门判定

| 发布门 | 判定 | 依据 |
| --- | --- | --- |
| 学习门（闭环含再提取 + 延迟未见变式） | **v2 分支通过；生产构建不通过** | `releaseGate.ts:28` 关闭；v1 允许作答后直接结束 |
| 摩擦门（非学习操作 ≤ 15%） | **未测量** | 无任何真实会话样本；`validation.md` 自述单测不能建立摩擦比 |
| 权威门（AI 不产生不可逆独立通过） | **通过** | `evidencePolicy.ts:322-341` 三重门 + objective/provisional 分离 |
| 注意力门（同屏最多一个效果指标） | **驾驶舱内通过；StatsPage 不通过** | `ReviewCoachWorkbench.tsx:198-210` vs `StatsPage.tsx:62-78` |
| 场景门（只服务真实备考场景） | **通过** | dev plan §2.3 准入声明 |
| 工程门（数据/隐私/迁移/同步/备份/设备） | **通过（本地验收）** | StudyJournal 176 文件 / 1117 测试；live provider 与真机门禁仍开放 |

---

## 6. 待办清单（按优先级）

1. **跑一次摩擦门**（零代码改动）。在 `review-coach-v2` 内部 mode 下完成 10 次真实新流程会话，用 `buildFrictionReport` 出 `operationRatio`，把数字与日期写进 `validation.md`。在此之前，第 3 条的 15% 预算处于"未证"状态，不能宣称达标。
2. **决定 `PRODUCTION_V2_ENABLED` 的翻转时点**。这是唯一能让线上流程合宪的开关；它需要 M0–M5 的 Go 条件全绿，而第 1 条（摩擦门）目前是卡的。
3. **注意力门整改**：StatsPage 同屏指标收敛到 1 个；移除或重构"连续复习"与"打卡热力图"。若产品决定保留它们，必须走宪法修订流程（说明改哪条、解决什么真实冲突、依据什么证据、新增什么长期成本），不能在代码层临时决定。
4. **补第 13 条的第②类结果**："同一错因是否复发（是/否）"目前全库无实现，且它同时是 dev plan §2.4 的第三层证据。
5. **小补丁**：`REVIEW_COACH_ROLE_SYSTEM_PROMPT` 增加"不评价努力或思路、不使用鼓励性开场结尾"。

---

## 7. 核查方法说明

- 判定以源码为一手证据，不以方案或文档自述为准；关键论断均给出 `文件:行号`。
- 区分三种状态：**通过**（有实现且有证据）、**机制通过但未启用/未测量**（有实现，无生效或无声称证据）、**不通过**（与条文直接冲突）。
- 未执行任何测试或构建；本核查不改变任何代码。
- 摩擦相关结论的样本量为 0，故"未测量"不是"通过"也不是"不通过"。
