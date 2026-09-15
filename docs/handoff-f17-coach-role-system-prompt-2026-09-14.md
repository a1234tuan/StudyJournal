# 交接说明：驾驶舱角色级 System Prompt（F-17「提示词污染」）

> **状态更新（2026-09-15）**：本文是实施前的历史交接稿，其中“代码一行未动”只描述 2026-09-14 撰写时的状态。相关改造已在 `da8b566` 完成并通过本地验收；当前事实与验收结果以 `docs/ai-cockpit-remediation-acceptance-2026-09-14.md`、`AGENTS.md` 和源码为准。以下正文保留用于追溯设计理由，不再作为待办清单。

> **面向对象**：刚接手本仓库、尚未读过任何上下文的 AI Coding Agent。
> **撰写日期**：2026-09-14
> **当前状态**：**方案已定，代码一行未动**。本文件是交接说明，不是变更记录；仓库里目前没有任何针对本项的改动。
> **上游依据**：`docs/audit/ai-cockpit-learning-effect-audit-2026-09-14.md`（发现 F-17，§2 表格）、`docs/ai-cockpit-remediation-plan-2026-09-14.md`（修复批次 C-1、风险评估 §0.2）
> **本文的任务**：让另一个 agent 在**不读完整仓库**的前提下，理解为什么改、改在哪、怎么改、改完到底有没有用。

---

## 0. 开工前必须知道的四件事（不遵守会踩坏东西）

1. **产品与工程边界**：`docs/新的方案.md` 是产品边界；`AGENTS.md` 是工程基线，改任何东西前先读它的「Current Baseline」。
2. **语音复述已冻结**：`src/features/voiceRecall/**` 处于冻结状态（`docs/voice-recall-freeze-2026-09-11.md`），其 system prompt 文本有**逐字冻结断言**（`teacherPrompt.test.ts:18-46`）。**本项不要碰它**——但它恰好是本项要模仿的样板（见 §4.2）。
3. **不需要改 schema、不需要改同步实体**：数据库 schema 21（`src/db/reviewCoachSchema.ts`）。本项是纯提示词环境改造。
4. **错误渲染约定**：所有 React 页面/组件抛出的错误必须经过 `src/lib/uiError.ts`；`src/lib/uiErrorSurface.test.ts` 会拦截裸 `error.message` 回归。

**基线（改动前先跑一遍，改完必须还是绿的）**

```bash
npx vitest run src/features/reviewCoach          # 期望：17 文件 / 94 项全绿
npx vitest run src/services/aiClientService.test.ts
```

---

## 1. 项目背景：这是什么，这块代码在哪

### 1.1 项目

本地优先的**学习日志应用**（Web / Desktop / Android 共用一套源码，Capacitor + React + Dexie/IndexedDB）。用户写日志 → 系统从中抽取「决策块」→ AI 基于决策块做**主动回忆训练**与**延迟验证**。云同步与备份是可选项，不是必需路径。

### 1.2 "AI 驾驶舱" 就是 Review Coach

代码位置：`src/features/reviewCoach/**`。

它是一个**双层 AI 中枢**：

| 层 | 文件 | 干什么 |
| --- | --- | --- |
| 深度模型 | `sessionPlanningGateway.ts` | 产出 `SessionBlueprint`（一次训练计划） |
| 快速模型 | `aiGateway.ts` | 把用户评论整理成结构化理解 `FeedbackInterpretation` |
| 快速模型 | `quizExecutionGateway.ts` | 三个角色：`generateTurn` 逐轮出题、`reviewQuestion` 题目质检、`evaluateAnswer` 答案评估 |
| 非 AI | `orchestrator.ts` / `replay.ts` / `repository.ts` | 状态机、投影重算、持久化 |

**这 5 个 AI 角色（评论整理 / 会话规划 / 逐轮出题 / 题目质检 / 答案评估）全部经由同一个传输入口：`sendChatCompletionDetailed`。**

### 1.3 关键：一次 AI 调用的消息是怎么拼出来的

集中在 `src/services/aiClientService.ts`：

```
SYSTEM_PROMPT                    (:64-69)   给"普通聊天问答"写的全局提示词
buildAiMessages()                (:216-263) 消息组装（第一行就无条件注入上面那段）
requestOpenAiChatCompletionDetailed (:331+) 实际发请求
  ├─ Web     → fetch           (:381)  response_format: { type: "json_object" }
  └─ Native  → runNativeAiChat (:342)  Desktop/Android，两条路径共用同一个 messages 数组
sendChatCompletion()             (:533)     普通问答入口
sendChatCompletionDetailed()     (:551)     驾驶舱入口（也是知识播客的入口）
```

**请特别注意 `buildAiMessages` 的第一行**（`:224`）：

```ts
const messages: AiChatPayloadMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
```

**没有任何条件判断。** 这是整个 F-17 的根。

而驾驶舱三个网关全部传 `history: []` 且不带 `attachment`（`aiGateway.ts:70`、`quizExecutionGateway.ts:35`、`sessionPlanningGateway.ts:57`），所以一次驾驶舱调用**最终只发两条消息**：

```
[
  { role: "system", content: SYSTEM_PROMPT },              ← 全局，优先级最高
  { role: "user",   content: "驾驶舱角色指令 + 输入数据" }
]
```

---

## 2. 问题一：改动的原因是什么？

### 2.1 一句话

**驾驶舱的每一个 AI 角色，每次调用都会被强行塞进一段为"普通聊天问答"写的 System Prompt，而这段提示词要求的东西，和驾驶舱自己要求的东西正好相反。**

编号 **F-17**，严重度 **P1**。

### 2.2 冲突的确切内容

| 消息 | 位置 | 要求 |
| --- | --- | --- |
| `system` | `aiClientService.ts:64-69`（全局 `SYSTEM_PROMPT`，其中 `:68`） | "使用 **Markdown 和 LaTeX**，不要输出 HTML。使用日志内容时，**结尾简短列出依据来源**。" |
| `user` | `quizExecutionGateway.ts:27`、`aiGateway.ts:44`、`sessionPlanningGateway.ts:54` | "**只输出 JSON，不要 Markdown 或代码围栏。**" |

同一个模型、同一批消息、两条互相否定的输出格式要求。

### 2.3 为什么这构成"污染"而不是普通冗余 —— 优先级倒置

在 OpenAI 兼容协议里，`system` 的角色语义就是"全局行为约束"，**优先级高于 `user`**。而驾驶舱的全部约束**恰好都写在 `user` 消息里**。

于是：**应该让位的通用约束占了最高优先级，真正该生效的驾驶舱约束反而处在低位。**

这不是"多了一句废话"，而是**指令环境本身是错的**。这就是"提示词污染"的含义。

### 2.4 影响半径

| 消费者 | 位置 | 是否受影响 |
| --- | --- | --- |
| 驾驶舱 5 个角色 | `aiGateway.ts:67`、`sessionPlanningGateway.ts:54`、`quizExecutionGateway.ts:32`（内含 3 角色） | **是**，全部继承 |
| 普通聊天问答 | `sendChatCompletion`（`:533`） | **是，但这是设计意图**——那段提示词本来就是给它的，不要动 |
| 知识播客 | `knowledgePodcastService.ts:542` | **是，且更严重**，见 §6 |

### 2.5 可观测的症状链（这些是"确凿发生过"的证据，不是推测）

1. **输出被包在 ` ```json ` 围栏里。**
   **旁证**：同仓库已经有专门的剥围栏代码 —— `src/features/reviewCoach/aiGateway.ts:29` 的 `parseJsonContent` 第一件事就是匹配 `^```(?:json)?\s*([\s\S]*?)\s*```$` 再 `JSON.parse`。**团队不会平白无故写这段逻辑，说明真实撞上过。**

2. **但剥围栏的覆盖是窄的。** 该正则**锚定 `^...$`**，只处理"整个回复就是一个围栏块"。若模型按 system 要求「在 JSON 之后补一段依据来源」，就变成"围栏 + 额外文字"，正则匹配不上 → `JSON.parse` 失败 → 抛 `AiSchemaError`。

3. **失败后不会重试。** `AiSchemaError`（`aiClientService.ts:52-54`）的构造是 `super(message, false, ...)`，即 **`retryable = false`**。加上结构化输出只发 `response_format: { type: "json_object" }`（`:387`）——**它不带 JSON Schema，服务端不做强制校验**，唯一约束就是提示词文本。提示词一被污染，用户看到的就是一句报错，系统不会自己再试。

4. **字段被擅自增加。** system 让模型"列依据来源"，它很可能就在 JSON 里多加一个字段；而各网关的解析器用 `assertExactKeys`（如 `aiSchemas.ts:414`）**多一个键就判非法**。

### 2.6 它和 F-04 / F-20 是同一病根

这三条合起来指向一个共同缺陷：**整个模块过度依赖"提示词文本"作为唯一约束**。

- **F-17**：格式约束被高位提示词否掉（本项）。
- **F-04**：`quizExecutionGateway.ts:47` 把 `practiceType` 枚举写成 `concept|calculation|discrimination|cloze|variation|chunk`，而真正常量在 `aiSchemas.ts:127-135`，是 `concept-question|calculation|distinction|cloze|variation|chunk-training|prerequisite-check` —— **7 个值里 5 个对不上**。
- **F-20**：`quizExecutionGateway.ts:46` 写了"题目中不得泄露答案或判据"，但**全仓没有任何本地校验**。

所以修复思路也是共同的：**把"靠提示词"的部分，逐步换成"靠本地校验"**（F-17 先把提示词环境修对，F-04 做同源生成，F-20 加本地检查）。

---

## 3. 问题二：这个改动点在流程里处于什么地位、发挥什么功能？

### 3.1 位置：AI 网关层的**最底层传输入口**

它在 UI / hook 与模型之间，是**所有驾驶舱 AI 调用的必经之路**：

```
UI (AdaptiveReviewPage / ReviewCoachWorkbench)
  ↓
hooks (useAppData: submitAdaptiveQuizAnswer / generateAdaptiveQuizTurn ...)
  ↓
orchestrator (状态机 + 幂等 + 校验)
  ↓
网关（aiGateway / sessionPlanningGateway / quizExecutionGateway）← 各角色的"业务指令"在这里
  ↓
★ sendChatCompletionDetailed / buildAiMessages ← F-17 在这一层，决定"模型看到的指令环境"  ★
  ↓
模型 Provider
```

### 3.2 功能：它决定的是**指令环境**，而不是某一条具体指令

上层 5 个角色的所有努力（JSON-only、闭卷不给答案、不许增字段、判据不得外引）**都只是建议**。它们能否生效，取决于这一层注入的 `system` 消息是否与它们一致。

打个比方：**这不是"某个角色把提示词写错了"，而是"所有角色都要穿过的那道门有问题"。** 门有问题，门后每个人写得再对也没用。

这也解释了为什么它被定为 P1 而其他同类问题只是 P2：**它的失效是"每次调用都必然带着一个反向指令"，是确定性失败源，不是偶发。**

### 3.3 依赖关系：它是别的东西的**前置条件**

| 关系 | 说明 |
| --- | --- |
| 是 **F-04 / F-18 / F-20** 的前置 | 提示词环境自相矛盾时，再精确的提示词也可能被高位指令否掉 |
| 是 **修复批次 A（让效果可度量）能成立的前提** | A 批要把 AI 判题结果聚合成"客观答对率"。如果评估器频繁因格式冲突而报错，或被 system 诱导输出多余内容，那个客观指标本身就掺了噪声、不可信 |
| **本身不产出任何学习效果** | 它是**使能项（enabler）**。请不要把它当效果功能交付或宣传 |

---

## 4. 问题三：具体怎么改？为什么这么改？

### 4.1 改动清单（4 个文件 + 1 个新文件 + 测试）

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `src/services/aiClientService.ts` | 参数化 system prompt（见下） |
| 2 | `src/features/reviewCoach/rolePrompts.ts` | **新增**，导出 `REVIEW_COACH_ROLE_SYSTEM_PROMPT` |
| 3 | `src/features/reviewCoach/aiGateway.ts:67` | 传 `systemPrompt` |
| 4 | `src/features/reviewCoach/sessionPlanningGateway.ts:54` | 传 `systemPrompt` |
| 5 | `src/features/reviewCoach/quizExecutionGateway.ts:32` | 传 `systemPrompt`（`request()` 内统一传，覆盖 3 个角色） |
| 6 | 新增 `src/services/aiClientService.systemPrompt.test.ts` + 各网关测试补断言 | 见 §4.5 |

#### 第 1 个文件的细节（最容易改坏的地方）

- `SYSTEM_PROMPT`（`:64`）**改名**为 `CHAT_SYSTEM_PROMPT` 并加 `export`（便于测试引用）。**文本一个字都不要改**——普通问答依赖它。
- `AiCompletionRequestOptions`（`:56-61`）新增 `systemPrompt?: string`。
- `buildAiMessages`（`:216`）**在参数列表最后**追加 `systemPrompt?: string`；未传时回退到 `CHAT_SYSTEM_PROMPT`。
  - ⚠️ **不要改参数顺序、不要改成必填。** 现有调用点和既有测试都依赖现状：
    - 调用点：`aiClientService.ts:533`、`:569`
    - 测试：`aiClientService.test.ts:78`（2 参）、`:89`（多参）、`:139`（4 参）、`:159`（5 参）
- `sendChatCompletionDetailed`（`:569`）把 `options.request?.systemPrompt` 透传给 `buildAiMessages`。
- `sendChatCompletion`（`:533`，普通问答）**不要传** → 行为完全不变。
- **必须复核的一点**：`sendChatCompletionDetailed` 结尾有 `...options.request` 展开（`:571`）。要确认 `request.systemPrompt` **不会**被带进 HTTP 请求体。`requestOpenAiChatCompletionDetailed` 是显式挑字段拼 body 的（`:382` 起，只列 `model / messages / temperature / max_tokens / response_format / thinking / reasoning_effort`），所以预期安全，但请**加一条断言**把这件事钉死。
- Native 路径（Desktop/Android）走 `runNativeAiChat`，它只是把 `messages` 序列化后传给宿主（`nativeAi.ts:34-42`），**所以只改 `buildAiMessages` 就能同时覆盖 Web 与 Native，不需要动宿主桥接**。

### 4.2 为什么这么改，而不是别的做法

| 替代方案 | 为什么不选 |
| --- | --- |
| 在 user 消息里再强调一遍"不要 Markdown" | **治不了**。冲突的本质是 `system` 与 `user` 的**优先级**，重复一条低位指令不会改变高位约束 |
| 全局删掉 `SYSTEM_PROMPT` | 会破坏普通问答（那段正是为它写的），而且无法给不同角色不同约束 |
| 只用 `response_format: json_schema` 强制结构 | 只能约束"它是 JSON"，**管不了"模型往 JSON 里多塞一个依据来源字段"或"输出 LaTeX 片段"**；且当前只发 `{type:"json_object"}`，并非所有 provider 都支持 `json_schema`。可作**后续加固**，不能替代本项 |
| 出口做清洗（剥围栏、删多余字段） | 只治症状。`parseJsonContent` 已经在剥围栏，但那是**窄匹配**（整段一个围栏），且**挽救不了已经跑偏的语义**（模型若把"依据来源"当成必填项，反而会在 JSON 里编造来源）。**当前代码里的剥围栏正是这条路走到尽头的证据** |
| 每个角色单独写一个传输函数 | 改动面大，且会和 Native 路径分叉。当前设计是"**一个入口 + 参数化 system prompt**"，最小且一次覆盖两条路径 |
| 让各网关把业务指令从 user 提成 system | 不必要。角色业务约束留在 user 消息里是合理的分层：system 只管"输出契约"，user 管"这一轮干什么" |

### 4.3 role prompt 文本（草案，需评审）

新增 `src/features/reviewCoach/rolePrompts.ts`：

```ts
/** 驾驶舱各 AI 角色的输出契约。只约束"怎么输出"，不写业务约束——
 * 业务约束（闭卷、不给答案、不得跨块引用）留在各网关的 user 消息里，
 * 这样本段文本可以长期稳定，不随业务迭代改动。 */
export const REVIEW_COACH_ROLE_SYSTEM_PROMPT = [
  "你是一个结构化数据生成器，为本地学习日志应用输出 JSON。",
  "只输出一个 JSON 对象：不要 Markdown，不要代码围栏，不要 LaTeX，不要在 JSON 之外追加任何文字（包括依据来源列表或结尾说明）。",
  "严格使用输入中要求的字段名与取值，不得增加、删除或重命名字段。",
  "不得改变输入中给定的目标、来源引用与版本号；不得据输入之外的知识补造事实。",
  "信息不足时，按输入要求返回 insufficient-context，不要猜测。",
].join("\n");
```

**五个设计要点（评审时按这五条看）**

1. **身份先行**："结构化数据生成器" —— 直接对冲全局提示词的"学习助手"人设。
2. **逐条否掉 system 的四项要求**：Markdown / 代码围栏 / LaTeX / **JSON 之外的文字（含依据来源列表）**。最后一项最容易被漏掉，而它正是症状链第 2 条的来源。
3. **显式禁止增删字段** —— 对应 `assertExactKeys`，把"多一个键就判非法"提前告知模型。
4. **保留审计边界**：不得改变目标、来源引用、版本 —— 与 `quizExecutionGateway.ts:25` 既有条款语义一致，不引入新约束。
5. **不写业务约束** —— 保持这段文本稳定，避免每次业务迭代都要动它（也避免与 F-04 的"同源生成"改造互相干扰）。

### 4.4 必须遵守的项目约束（否则改完不能合）

- ⚠️ **本项改变模型实际看到的指令**，属于 `AGENTS.md` 定义的「受控真实 Provider 验收」范围。**必须单独批准做一次付费验收，不能只看单测绿，不得并进普通回归。**
  - 建议形状：1 个决策块 ×（1 次评论整理 + 1 轮出题 + 1 次判题），`deepseek-v4-flash`；把结果写进 `docs/` 下新增的验收记录文件。
  - 验收时同时记录**改动前/后各 N 次调用的解析成功率**（`AiSchemaError` 计数 + 重试计数），否则无法回答"到底有没有降低失败率"（见 §5.3）。
- ⚠️ **是否要 bump `PROMPT_VERSION`：需要判定，建议 bump。**
  `aiSchemas.ts:10-13` 的 4 个提示词版本常量被写进 `AdaptiveQuizTurn.promptVersion` 与 `SessionBlueprint.promptVersion`，而**效果归因的 `strategyKey` 包含 `promptVersion`**（`replay.ts:179`）。**改了指令环境却不同步版本号，会让改动前后不同指令下的效果样本被错误地合并统计**，直接污染批次 A 的指标。建议与 F-04 一起 bump（如 `quiz-turn-v2 → v3`、`answer-evaluation-v1 → v2`）。
  ⚠️ **但语音复述的 system prompt 文本是冻结的**（`teacherPrompt.test.ts:18-46` 有逐字断言），与驾驶舱版本号无关，**不要动**。
- **不要**改 schema、**不要**改同步实体、**不要**动 `REVIEW_COACH_REPLAY_VERSION`（那是批次 A-2 的事）。
- 错误渲染走 `src/lib/uiError.ts`。

### 4.5 验收测试

新增 `src/services/aiClientService.systemPrompt.test.ts`：

- 传入 `systemPrompt` → 断言 `messages[0]` 的 `content` 等于传入值，**且不含** `"Markdown"`、`"LaTeX"`、`"列出依据来源"`。
- **不传** `systemPrompt` → 断言 `messages[0].content` 与改动前完全一致（防回归，这是最重要的一条）。
- 断言 `request.systemPrompt` **不出现**在 HTTP body 里（§4.1 的复核项）。

各网关测试补一条：

- `aiGateway.test.ts` / `sessionPlanningGateway.test.ts` / `quizExecutionGateway.test.ts` 各断言 `sendChatCompletionDetailed` 收到的 `request.systemPrompt === REVIEW_COACH_ROLE_SYSTEM_PROMPT`。

`quizExecutionGateway.test.ts:39` 已经在读 `mock.calls` 的 `request`，照它的写法加即可。

---

## 5. 问题四：这么改能否真正带来学习效果、真正规避风险？

分三层回答，`不粉饰`。

### 5.1 它**不产生**学习效果 —— 请不要这样交付

学习效果的来源是「主动回忆 + 延迟验证 + 出题难度自适应」这三件事。F-17 修复对这三件事**一点都帮不上**。

**它是使能项，不是效果功能。** 如果有人问"做完这个学习效果会变好吗"，正确答案是"不会，但它让'效果到底好不好'这个问题的答案变得可信"。

### 5.2 但它确实规避了三类**可观测的**风险（这部分是真的）

| 风险 | 现状 | 改后 |
| --- | --- | --- |
| 格式冲突导致调用失败 | **概率性**：取决于模型当天多听 system；且失败后 `retryable=false` 不重试 → 用户看到报错、**做不上题**（而这是付费调用，钱已花） | 指令环境自洽，这一类失败从"提示词运气"变成"由我们自己的指令决定" |
| 字段被擅自增加 | system 要求"结尾列来源"，可能诱发模型在 JSON 里加字段 → `assertExactKeys` 判非法 | 明确禁止 JSON 之外的任何附加内容 |
| 输出被 LaTeX / Markdown 污染 | 若污染的是**题干或判据**，会直接改变用户看到的题与判分依据（属于学习内容层面的失真） | 格式面收敛 |

### 5.3 边界与不确定性 —— 必须说清楚的部分

1. **不能保证 100% 消除。** 模型仍可能无视 system prompt。所以本项**必须和 F-04（提示词与 schema 同源生成）、F-20（本地泄漏检查）一起做**，把"靠提示词"的部分逐步换成"靠本地校验"。**只做 F-17 会在几个月后以另一种形式复发。**
2. **"是否真的降低了失败率"需要实测，不能假设。** 建议验收时记录改动前后各 N 次调用的解析成功率。**如果失败率本来就接近 0**，那么本项的价值主要在「消除不确定性」和「让 A 批指标可信」，而不是当下省掉多少报错——这个结论要如实报告，不要为了证明改动有价值而夸大。
3. **A 批（客观指标）的可信度依赖本项** —— 这是本项最实际的收益。若指令环境矛盾，评估器的输出可能被 system 影响（例如被要求"输出 LaTeX"或"列来源"），那么批次 A 统计出来的"客观答对率"就掺了噪声，"自评 vs 客观"的差距分析也就不可信。
4. **会引入新的回归风险**（改变了模型所见指令）→ 所以有 §4.4 那条付费验收硬约束。
5. **它不能修复"证据是否真实"的问题。** 那是 F-18（评估器看不到原始材料）和 F-02（效果指标只数自评）的范畴。本项只保证"模型的输出契约被稳定执行"，**不保证判题本身判得对**。

### 5.4 一句话结论

> **本项不是学习效果功能，而是"证据链可信"的前置条件。** 它把一类"靠模型当天心情"的失败，变成"由我们自己的指令决定"的结果；同时它是批次 A 那些客观指标能否被信任的前提。

---

## 6. 范围外的同根因问题（已记入审计报告 F-21）

准备本交接时发现：**知识播客有同一根因，而且更严重。**

- `knowledgePodcastService.ts:408`、`:411` 要求"输出纯 JSON，不要 Markdown 代码围栏，不要解释 JSON 以外的内容"。
- 但它**同时传了 `attachment`**（`:542`），于是 `buildAiMessages` 会**额外注入一条 system 消息**（`aiClientService.ts:245`）："回答要求：如果使用了日志内容，请在回答末尾写'依据来源：[[S1]] 来源标签……'"
- 再加上全局 `SYSTEM_PROMPT` 的"Markdown + 结尾列来源"，**它一共拿到三条互相否定的指令**。
- **旁证**：`knowledgePodcastService.ts:535` 有一个"AI 第一次未返回可用脚本，正在进行最后一次重试"的循环 —— 团队已经撞上过。

**建议**：同批给播客也传一个 role prompt（它需要的与全局那段最接近，只是要去掉"结尾列来源"），并复核那条 `attachment` 注入的 system 消息是否应该降级为 user 消息。

**注意范围**：F-21 **不属 AI 驾驶舱**，不计入驾驶舱的发现数。它被记录的意义是证明 —— "全局 System Prompt 无条件注入 + 各功能自行写格式要求"是**传输层设计缺陷**；只修驾驶舱，同类故障仍会在播客复现。

---

## 7. 开工顺序建议

1. 读 §0 + §1.3，跑基线测试（`reviewCoach` + `aiClientService`）。
2. 确认 §4.4 的两个判定项（是否 bump promptVersion、播客是否同批）——**这两条需要人拍板，不要自己决定**。
3. 改 `aiClientService.ts`（参数化），先让既有测试保持全绿。
4. 新增 `rolePrompts.ts`，3 个网关接线。
5. 补测试（§4.5），全量回归 + `npm run build`。
6. **提交单独批准的受控真实 Provider 验收**（deepseek-v4-flash），记录解析成功率与重试计数。
7. 写验收记录到 `docs/`，并在 `AGENTS.md` 的 Current Baseline 里补一条本项已完成的事实描述。

---

## 附：快速导航表

| 目的 | 位置 |
| --- | --- |
| 全局 System Prompt 原文 | `src/services/aiClientService.ts:64-69` |
| 无条件注入点 | `src/services/aiClientService.ts:224` |
| 消息组装函数 | `src/services/aiClientService.ts:216-263` |
| 请求体拼装（确认 systemPrompt 不外泄） | `src/services/aiClientService.ts:382-390` |
| `AiSchemaError` 不可重试 | `src/services/aiClientService.ts:52-54` |
| 剥围栏逻辑（症状旁证） | `src/features/reviewCoach/aiGateway.ts:29` |
| 驾驶舱 3 个网关的调用点 | `aiGateway.ts:67`、`sessionPlanningGateway.ts:54`、`quizExecutionGateway.ts:32` |
| 角色级 system prompt 的既有样板 | `src/features/voiceRecall/teacherPrompt.ts:49-60` |
| 指令/内容信任边界机制（可借鉴） | `src/features/voiceRecall/contentBoundary.ts`、`openAiLlmStreamAdapter.ts:13-20` |
| 审计发现 F-17 / F-21 | `docs/audit/ai-cockpit-learning-effect-audit-2026-09-14.md` §2 |
| 修复批次 C-1 | `docs/ai-cockpit-remediation-plan-2026-09-14.md` §4 |
| 风险与口径讨论 | 同文件 §0.1、§0.2 |
