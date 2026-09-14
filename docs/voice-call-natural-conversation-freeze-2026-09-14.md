# 语音通话自然对话重构与回归修复冻结方案

- 版本：`voice-conversation-design@1.0`
- 冻结日期：2026-09-14
- 范围：带可选材料上下文的自然语音通话
- v1 打断：仅支持按钮打断；播放期间关闭麦克风，不支持语音 barge-in/AEC

## 设计原则

语音通话由用户先说，模型根据多轮上下文自然回应。材料模式把选中日志作为参考材料，不把折叠块、标签或排版组件当作知识点；自由主题仅作为起点，用户跑题时跟随用户。应用层只管理设备、生命周期和明确控制，不预分类用户意图，也不强制教学流程。

## Prompt 冻结

版本标识：`voice-conversation-prompt@1.0`。固定顺序为：指令块 → 示例 → `conversation_context` → 最近对话历史 → 当前用户输入。示例必须保留，变量内容放在静态指令和示例之后；空主题完全省略主题区块。

系统提示词只定义通话身份、适合朗读的口语风格、适中回复长度和必要时澄清。通常回复 1–3 句、尽量 50 字以内；不输出列表、Markdown 或格式符号。不得使用固定第一问、知识点计划或旧 `opening/follow-up/next-topic` 教学协议。模型输出为普通文本；`teacherText` 是历史命名，实际表示 AI 回复。

### Canonical system prompt

以下文本逐字冻结，由 `src/features/voiceRecall/teacherPrompt.ts` 的 `VOICE_CONVERSATION_SYSTEM_PROMPT` 导出，并由 Prompt 回归测试完整比较。除版本化变更外，不得在调用方重复拼接规则：

```text
你正在和用户进行一通语音电话。你说的每个字都会被转换成语音播放给对方，所以请像打电话一样自然说话。

每次回复通常使用 1–3 句话，尽量控制在 50 字以内。内容较多时，先说最核心的一点；如果继续展开确实有帮助，可以先讲一小段，再询问对方是否继续。

使用自然口语，不使用列表、Markdown 或格式化标题。遇到公式、数字、英文名称或符号时，用适合朗读的方式准确表达，不要机械朗读排版符号。

默认先回应对方刚才表达的内容，再根据对话需要自然推进。可以在有助于理解、继续讨论或用户明确邀请时提问，但不要为了维持某种固定流程而提问。

对方的话经过语音识别转写，可能存在同音字、断句或少量识别错误。能够根据上下文判断原意时，直接按合理原意回应；只有数字、名称或其他关键信息可能影响回答时，才向对方确认。

示例：

用户：我昨天看的傅里叶变换还是没太懂。

你：你卡在哪一步？是不太理解它为什么能把时域变成频域吗？

用户：对，就是这里。

你：那我从一个直觉的比喻讲起，一次说一小段，你随时打断我。
```

生产请求不再包含 `userControlInstruction`、`<voice_control>`、`opening`、`follow-up`、`next-topic` 或教学状态修复指令。停止通话由本地状态机处理；其他用户话语作为普通上下文交给模型。

## 五阶段实施

### 阶段一：基线审计与 Prompt 冻结

冻结提示词、材料/自由主题模板和消息顺序；保留材料字符上限；补齐 Prompt 顺序、示例、空主题和旧残留测试。阶段完成后运行定向测试、完整确定性回归、构建、`git diff --check`，并执行 `neat-freak`。

### 阶段二：自然对话协议与首轮交互

删除自动 opening LLM 请求和固定答题 fallback。接通后播放本机固定提示“已接通，你可以直接说。”，优先使用系统语音，不调用云端 TTS；系统语音不可用时保留字幕提示。用户首句之后才调用 LLM。普通响应允许直接回答、讲解、判断、闲聊；只有确实无法回答时澄清。明确停止、暂停、继续、结束仍由本地控制。旧 `teacherProtocol`、`dialoguePolicy` 和 pipeline policy 不再属于生产实现。

### 阶段三：半双工、按钮打断与 ASR 恢复

状态流为 `connecting → listening → transcribing → thinking → speaking → listening`。播放中麦克风关闭，按钮打断停止播放、清空队列、标记中断并重新监听。ASR 错误区分无语音、空转写、超时、断连和麦克风错误；每轮最多自动重试一次，成功轮次归零，旧任务通过 `turnId/operationId/epoch` 隔离。

### 阶段四：播放一致性、字幕持久化与恢复

每轮保存用户文本、完整 AI 文本、`playedText`、`pendingText` 和播放状态。保存先于播放是 v1 的有意取舍。下一轮上下文只使用实际播放内容；“继续”直接播放 pending，不重新调用 LLM。turns、checkpoint 和摘要持久保存，LLM 上下文最多使用最近 10 个已完成 turns；语音数据保持本地-only。

当前实现允许从本机历史重新打开已结束 session，先以暂停态加载完整 turns，再由用户主动继续；新建 session 不继承旧字幕。

### 阶段五：预算、兼容性与观测

LLM `max_tokens` 默认 224、全局不超过 250；thinking 仅对明确声明支持的 provider 启用，默认不发送。固定文案不调用远程 TTS，使用本机系统语音或字幕 fallback。记录 token、各阶段延迟、首音延迟、回复长度、问句结尾、打断、ASR 重试、错误和播放状态，统计提问率、长度分布、打断率及恢复率。真实 provider 测试保持 opt-in。

当前实现还提供本机系统语音的固定接通提示 fallback；它不调用 LLM、云端 TTS 或 provider 额度。浏览器/WebView 不提供系统语音时，接通字幕仍显示相同文案。

## 数据与兼容约束

保留 `voiceRecallTurns` 及旧 `teacherText` 字段，不做数据库重命名；新增字段优先使用 `assistantText`、`playedText`、`pendingText`、`playbackStatus`、`systemGenerated`。系统 fallback 不作为普通 assistant 历史写入上下文。新 session 不继承旧字幕；同一 session 恢复完整 turns。

## 验收门禁

每阶段必须有阶段专属测试、相关回归、`npm run build`、`git diff --check`、`neat-freak` 和验收记录。五阶段全部完成前不邀请用户体验验收。最终验收覆盖首轮用户先说、5 轮自然对话、材料/自由主题、按钮打断、ASR 重试、session 恢复、字幕完整性和 pending 继续播放。

## 明确不在范围内

语音 barge-in、播放中持续收音、AEC、滚动摘要、数据库全面重命名、普通对话开关、SiliconFlow 实时 ASR，以及未经真实账号验证的 provider 能力承诺。

## 阶段记录

- 阶段一：Prompt 文本、示例、材料/主题模板和最近 10 轮历史预算已落地；canonical 文本逐字测试通过，旧协议残留已从生产请求链移除。
- 阶段二：普通轮次已停止依赖控制头，workspace 不再把模型输出强制解析为教学决策；确定性测试已迁移到用户先说和自然文本语义。
- 阶段三：ASR 单轮重试、成功后归零、旧任务代际隔离已有实现并通过 runtime 定向测试；按钮打断真机验证待完成。
- 阶段四：已完成 pending/completed/interrupted/failed 播放状态、失败 turn 保留、用户/AI 成对摘要、历史打开同一 session、最近 10 个已完成 turns 上下文预算；repository/runtime/workspace 定向回归通过。
- 阶段五：已完成 224/250 token 预算、provider thinking 能力协商、reasoning 排除、系统接通提示 fallback 和本机观测快照；provider adapter、production pipeline、workspace 定向回归与构建通过。

## 阶段验收记录

- 阶段一：Prompt 与消息顺序冻结为 `voice-conversation-prompt@1.0`；材料、自由主题、空主题、示例和历史窗口测试通过。
- 阶段二：首轮不调用 LLM；普通文本响应不依赖教学控制头；接通后用户先说；workspace 与 dialogue policy 回归通过。
- 阶段三：ASR 单轮最多自动重试一次并在成功后清零；播放期间仅按钮打断；runtime、ASR transport、capture 和 host 定向测试通过。真实 Android 本轮按钮打断仍属于最终真机门禁。
- 阶段四：turn 保存和恢复一致性测试通过；本机历史可打开同一 ended session；未完成播放内容保持 pending，不重新调用 LLM。
- 阶段五：`max_tokens`、thinking、reasoning、观测和本地提示测试通过；live provider、Playwright、Firebase 和 Android 真机门禁按发布检查表单独执行。
