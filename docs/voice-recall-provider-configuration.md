# 语音主动回忆 Provider 配置

## 当前可用性

- `voice-mock-cn@1`：确定性开发与自动化验收模板，不会访问真实 Provider。
- `voice-default-cn@2`：候选模板默认组合**阿里云 Paraformer 实时 ASR**、当前 LLM 和当前 TTS。开始页可分别选择 ASR、LLM 与 TTS；默认链路已于 2026-09-09 用受控账号完成真实服务验证。豆包流式 ASR 1.0/2.0、TTS 2.0 和小模型 TTS 已完成协议与宿主预接入，真实账号权限、音色和额度仍未验证，模板保持 `candidate`。
- Web：只允许 Mock、自建中继，或明确通过 `browserDirectSupported` 校验的配置。浏览器中不得长期暴露 Provider 密钥。实测：阿里云 ASR 需自定义 `Authorization` 头（浏览器 WebSocket 不支持），Fish Audio preflight 无 CORS 头，因此 Web 端不提供真实语音链路。
- Desktop/Android：真实链路仍需各 Provider 的宿主传输、凭据和受控连接测试。桌面端已实现主进程 WebSocket 代理（`study-journal:voice-asr-*`）与 TTS 宿主合成；Android 端已通过 NativeVoiceAsrPlugin 接入 OkHttp WebSocket；text/binary 帧有本地服务端自动化验证，真实设备仍待验收。

## 模板与本机覆盖

内置模板带 `templateId` 和递增 `version`。应用升级时采用新模板的默认组合和未覆盖默认值，但保留用户在本机明确选择的 ASR/LLM/TTS profile，以及 endpoint、模型、音色和运行参数。引用缺失或模板身份不匹配时必须停止并提示重新配置。

模板、模型、音色、价格和额度可能随供应商调整。只有完成专用测试账号验证后，才可把候选模板改为 `verified` 并填写验证日期；不得仅依据公开文档声称可用。

## 凭据与连接测试

- API Key 只保存在本机，不写入源码、日志、截图、测试夹具、备份或云同步。
- 连接测试使用专门测试账号、短请求和低额限制。
- 错误诊断只记录允许字段和本机估算，不记录完整 Prompt、学习正文、Authorization 或 Provider 原始响应。
- HTTP 401/403 提示凭据或权限问题；429 提示额度/限流。普通语音轮次不自动重发付费请求，由用户明确重试；教练仅对可重试错误执行有界、可取消的退避。
- ASR 在语音开始页保存本机密钥：阿里云使用 API Key；豆包新版使用 API Key，旧版同时填写 App ID 与 Access Token。LLM 与 TTS 按选中的 profile ID 查找本机密钥，内置 TTS 预置可回退到同供应商、同协议族的已配置 profile；豆包 V3 API Key 与小模型 V1 Access Token 不互相兜底。
- 豆包小模型 TTS 还需要旧版控制台 App ID；Access Token 仍保存在凭据表。服务选择或参数变化后必须重新确认披露。

## 上线前配置步骤

1. 在目标平台配置设备本机凭据和必要的可信中继/宿主传输。
2. 经单独批准额度后，验证 ASR 多句累计转写、用户校对确认、LLM 首 token、TTS 句级合成播放和取消。
3. 核对外发说明与实际请求字段一致。
4. 核对供应商账单、并发、数据保留和内容安全策略。
5. 完成 `voice-recall-release-checklist.md` 后，才调整模板验证状态。
