# 豆包语音配额兼容性

本页记录语音复述模块对火山引擎 / 豆包语音服务的兼容边界。所有凭据仅保存在设备本地 `aiSecrets`，不进入云同步、备份、导出或日志。

## 可作为独立阶段切换

- 流式语音识别 1.0：使用 SAUC V3 WebSocket，资源 ID 为 `volc.bigasr.sauc.duration`。
- 流式语音识别 2.0：使用相同的 SAUC V3 WebSocket，资源 ID 为 `volc.seedasr.sauc.duration`。
- 语音合成 2.0：使用大模型 TTS V3 单向流式 HTTP 接口，资源 ID / 模型为 `seed-tts-2.0`。
- 小模型语音合成：使用旧版 V1 HTTP 接口，需要 App ID、Access Token 和 `volcano_tts` 集群。

ASR 新控制台凭据使用 `X-Api-Key`。旧控制台凭据使用 `X-Api-App-Key` 与 `X-Api-Access-Key`。两种方式共用一个设备本地 ASR 凭据槽，由是否填写 Access Token 自动区分。

## 独立链路预支持

“端到端实时语音”不是 ASR、LLM 或 TTS 中的一个可替换阶段。它在一条会话协议中同时拥有识别、推理与合成，不能与当前模块化 `ASR -> LLM -> TTS` 链路混搭。本轮仅在界面明确其兼容状态，不提供不可运行的选择项；后续接入时应建立独立运行时、会话状态和计量路径。

## 官方协议参考

- ASR 1.0 / 2.0：<https://www.volcengine.com/docs/6561/1354869>
- 小模型语音合成：<https://www.volcengine.com/docs/6561/79820>
- 小模型语音合成参数：<https://www.volcengine.com/docs/6561/79823>
- 大模型 TTS V3：<https://www.volcengine.com/docs/6561/2532486>

真实账号激活、音色授权、额度扣减和 Android 真机音频表现仍需受控验收；普通自动化测试不得调用付费或真实 Provider。
