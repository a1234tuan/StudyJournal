import type { VoiceRecallProviderSetup } from "./VoiceRecallPresentation";
import { VoiceAsrCredentialSettings } from "./VoiceAsrCredentialSettings";

export const VoiceProviderSettings = ({ setup }: { setup: VoiceRecallProviderSetup }) => {
  const config = setup.config;
  const selectedAsr = setup.asrProfiles.find((profile) => profile.id === config.asrProfileId) ?? setup.asrProfiles[0];
  const selectedLlm = setup.llmProfiles.find((profile) => profile.id === config.llmProfileId) ?? setup.llmProfiles[0];
  const selectedTts = setup.ttsProfiles.find((profile) => profile.id === config.ttsProfileId) ?? setup.ttsProfiles[0];
  const change = (patch: Partial<typeof config>) => setup.onConfigChange({ ...config, ...patch });
  return <section className="vr-provider-body" aria-label="本机语音服务配置">
    <details><summary>ASR：{selectedAsr?.providerName ?? "未配置"}</summary>
      <label>语音识别服务<select aria-label="语音识别服务" value={selectedAsr?.id ?? ""} onChange={(event) => {
        const profile = setup.asrProfiles.find((item) => item.id === event.target.value);
        if (profile) change({ asrProfileId: profile.id, asrEndpoint: profile.endpoint, asrModel: profile.model ?? "", asrResourceId: profile.resourceId ?? "", asrOptions: profile.recognitionOptions });
      }}>{setup.asrProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.providerName}</option>)}</select></label>
      {selectedAsr && <VoiceAsrCredentialSettings profile={selectedAsr} />}
      <p>{selectedAsr?.providerId === "aliyun-nls"
        ? "识别模型由阿里云项目绑定；应用使用适合普通话复述的稳定默认参数。Access Token 过期后只需在上方更新。"
        : "应用会自动使用适合普通话复述的稳定默认参数，无需调整断句或文本规范化选项。"}</p>
    </details>
    <details><summary>LLM：{selectedLlm?.providerName ?? "未配置"}</summary>
      <label>大语言模型服务<select aria-label="大语言模型服务" value={selectedLlm?.id ?? ""} onChange={(event) => {
        const profile = setup.llmProfiles.find((item) => item.id === event.target.value);
        if (profile) change({ llmProfileId: profile.id, llmBaseUrl: profile.baseUrl, llmModel: profile.model });
      }}>{setup.llmProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.providerName} · {profile.model}</option>)}</select></label>
      <p>复用“更多 → AI 设置”中该配置及其本机密钥。</p>
      <label>模型<input value={config.llmModel} onChange={(event) => change({ llmModel: event.target.value })} /></label>
      <label>服务端点<input value={config.llmBaseUrl} onChange={(event) => change({ llmBaseUrl: event.target.value })} /></label>
    </details>
    <details><summary>TTS：{selectedTts?.providerName ?? "未配置"}</summary>
      <label>语音合成服务<select aria-label="语音合成服务" value={selectedTts?.id ?? ""} onChange={(event) => {
        const profile = setup.ttsProfiles.find((item) => item.id === event.target.value);
        if (profile) change({ ttsProfileId: profile.id, ttsEndpoint: profile.endpoint, ttsModel: profile.model, ttsVoice: profile.voice, ttsAppId: profile.appId ?? "" });
      }}>{setup.ttsProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.providerName} · {profile.model}</option>)}</select></label>
      <p>密钥复用“更多 → TTS 设置”中的同供应商、同协议本机配置；预置项可在这里覆盖模型和音色。</p>
      <label>模型<input value={config.ttsModel} onChange={(event) => change({ ttsModel: event.target.value })} /></label>
      <label>音色 ID<input value={config.ttsVoice} onChange={(event) => change({ ttsVoice: event.target.value })} /></label>
      {selectedTts?.providerId === "doubao" && config.ttsModel === "volcano_tts" && <label>旧版控制台 App ID<input value={config.ttsAppId ?? ""} onChange={(event) => change({ ttsAppId: event.target.value })} /></label>}
      <label>服务端点<input value={config.ttsEndpoint} onChange={(event) => change({ ttsEndpoint: event.target.value })} /></label>
    </details>
    <p className="vr-provider-compatibility"><strong>端到端实时语音</strong>同时接管 ASR、推理和 TTS，协议不属于上述任一阶段；当前已记录为独立链路预支持，暂不作为可混搭选项。</p>
  </section>;
};
