# 语音主动回忆 Provider 配置

## 当前可用性

- `voice-mock-cn@1`：确定性开发与自动化验收模板，不会访问真实 Provider。
- `voice-default-cn@2`：候选模板默认组合**阿里云 Paraformer 实时 ASR**、当前 LLM 和当前 TTS。开始页可分别选择 ASR、LLM 与 TTS；默认链路已于 2026-09-09 用受控账号完成真实服务验证。豆包流式 ASR 1.0/2.0、TTS 2.0 和小模型 TTS 已完成协议与宿主预接入，真实账号权限、音色和额度仍未验证，模板保持 `candidate`。
- `voice-asr-aliyun-nls-shiyinshi-v1`：独立候选 ASR，使用智能语音交互 NLS SpeechTranscriber 协议和项目中发布的 16 kHz 识音石 V1。2026-09-21 已完成受控真实 WebSocket 生命周期验收；Android 真机语音、多轮、弱网和过期恢复仍未验收，不能标记为 `verified`。
- Web：只允许 Mock、自建中继，或明确通过 `browserDirectSupported` 校验的配置。DashScope Paraformer 仍因 `Authorization` 头不能由浏览器 WebSocket 设置而禁止直连；NLS 使用 URL 中的短期 Token，可用于受控直连测试，但不应在浏览器长期保存凭据。Fish Audio preflight 仍无 CORS 许可，因此这不代表 Web 端完整 `ASR -> LLM -> TTS` 链路已经放行。
- Desktop/Android：真实链路仍需各 Provider 的宿主传输、凭据和受控连接测试。桌面端已实现主进程 WebSocket 代理（`study-journal:voice-asr-*`）与 TTS 宿主合成；Android 端已通过 NativeVoiceAsrPlugin 接入 OkHttp WebSocket；text/binary 帧有本地服务端自动化验证，真实设备仍待验收。

## 模板与本机覆盖

内置模板带 `templateId` 和递增 `version`。应用升级时采用新模板的默认组合和未覆盖默认值，但保留用户在本机明确选择的 ASR/LLM/TTS profile，以及 endpoint、模型、音色和运行参数。引用缺失或模板身份不匹配时必须停止并提示重新配置。

模板、模型、音色、价格和额度可能随供应商调整。只有完成专用测试账号验证后，才可把候选模板改为 `verified` 并填写验证日期；不得仅依据公开文档声称可用。

## 凭据与连接测试

- API Key 只保存在本机，不写入源码、日志、截图、测试夹具、备份或云同步。
- 连接测试使用专门测试账号、短请求和低额限制。
- 错误诊断只记录允许字段和本机估算，不记录完整 Prompt、学习正文、Authorization 或 Provider 原始响应。
- HTTP 401/403 提示凭据或权限问题；429 提示额度/限流。普通语音轮次不自动重发付费请求，由用户明确重试；教练仅对可重试错误执行有界、可取消的退避。
- ASR 在语音开始页保存本机凭据：DashScope Paraformer 使用 API Key；NLS 使用项目 AppKey + 临时 Access Token，保存到独立的 `voice-asr-aliyun-nls` 槽；豆包新版使用 API Key，旧版同时填写 App ID 与 Access Token。LLM 与 TTS 按选中的 profile ID 查找本机密钥，内置 TTS 预置可回退到同供应商、同协议族的已配置 profile；不同协议的凭据不互相兜底。
- 控制台生成的 NLS Token 只用于测试且 24 小时后失效。生产使用需由可信服务通过 SDK/OpenAPI 定期换取 Token；应用不接收、不保存 AccessKey Secret。重新获取 Token 不会使仍在有效期内的旧 Token 失效，实际过期时间以 `ExpireTime` 为准。
- 豆包小模型 TTS 还需要旧版控制台 App ID；Access Token 仍保存在凭据表。服务选择或参数变化后必须重新确认披露。

## 选择建议

- 默认保持已验证的 DashScope Paraformer ASR + Fish Audio TTS，不自动切换供应商。
- 识音石 V1 适合作为准确率对照和显式备选。首次使用时在阿里云项目发布 16 kHz 模型，在语音开始页选择该 ASR，并只填写项目 AppKey 与当前临时 Token。
- 豆包 ASR/TTS 和阿里云百炼 Qwen Audio TTS 继续作为可选择候选；只有完成真实账号、真机和账单验收后才能提升状态。
- 智能语音交互控制台中的 NLS TTS 选择不会自动接入本应用。本轮没有增加 NLS TTS，原因是尚缺独立宿主传输、Token 刷新、格式/首音延迟和取消语义验证。

官方协议：[实时语音识别 WebSocket](https://help.aliyun.com/zh/isi/developer-reference/websocket)、[Access Token 生命周期](https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token-1)。

## 上线前配置步骤

1. 在目标平台配置设备本机凭据和必要的可信中继/宿主传输。
2. 经单独批准额度后，验证 ASR 多句累计转写、用户校对确认、LLM 首 token、TTS 句级合成播放和取消。
3. 核对外发说明与实际请求字段一致。
4. 核对供应商账单、并发、数据保留和内容安全策略。
5. 完成 `voice-recall-release-checklist.md` 后，才调整模板验证状态。
