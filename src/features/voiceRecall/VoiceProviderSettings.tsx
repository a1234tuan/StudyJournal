import type { VoiceRecallProviderSetup } from "./VoiceRecallPresentation";
import { VoiceAsrCredentialSettings } from "./VoiceAsrCredentialSettings";

export const VoiceProviderSettings = ({ setup }: { setup: VoiceRecallProviderSetup }) => {
  const config = setup.config;
  const options = config.asrOptions ?? {};
  const selectedAsr = setup.asrProfiles.find((profile) => profile.id === config.asrProfileId) ?? setup.asrProfiles[0];
  const selectedLlm = setup.llmProfiles.find((profile) => profile.id === config.llmProfileId) ?? setup.llmProfiles[0];
  const selectedTts = setup.ttsProfiles.find((profile) => profile.id === config.ttsProfileId) ?? setup.ttsProfiles[0];
  const change = (patch: Partial<typeof config>) => setup.onConfigChange({ ...config, ...patch });
  const changeAsr = (patch: Partial<typeof options>) => change({ asrOptions: { ...options, ...patch } });
  return <section className="vr-provider-body" aria-label="本机语音服务配置">
    <details><summary>ASR：{selectedAsr?.providerName ?? "未配置"}</summary>
      <label>语音识别服务<select aria-label="语音识别服务" value={selectedAsr?.id ?? ""} onChange={(event) => {
        const profile = setup.asrProfiles.find((item) => item.id === event.target.value);
        if (profile) change({ asrProfileId: profile.id, asrEndpoint: profile.endpoint, asrModel: profile.model ?? "", asrResourceId: profile.resourceId ?? "", asrOptions: profile.recognitionOptions });
      }}>{setup.asrProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.providerName}</option>)}</select></label>
      {selectedAsr && <VoiceAsrCredentialSettings profile={selectedAsr} />}
      <label>模型<input value={config.asrModel} onChange={(event) => change({ asrModel: event.target.value })} /></label>
      <label>服务端点<input value={config.asrEndpoint} onChange={(event) => change({ asrEndpoint: event.target.value })} /></label>
      {selectedAsr?.providerId === "doubao" && <label>Resource ID<input value={config.asrResourceId} onChange={(event) => change({ asrResourceId: event.target.value })} /></label>}
      {selectedAsr?.providerId === "aliyun-bailian" && <>
        <label>语言提示<input aria-label="ASR 语言提示" value={(options.languageHints ?? ["zh", "en"]).join(",")} onChange={(event) => changeAsr({ languageHints: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></label>
        <label>热词列表 ID<input value={options.vocabularyId ?? ""} onChange={(event) => changeAsr({ vocabularyId: event.target.value })} placeholder="已有阿里云词表 ID" /></label>
        <label>句级静音（毫秒）<input type="number" min={200} max={6000} value={options.maxSentenceSilence ?? 1300} onChange={(event) => changeAsr({ maxSentenceSilence: Number(event.target.value) })} /></label>
        <label><input type="checkbox" checked={options.semanticPunctuationEnabled ?? false} onChange={(event) => changeAsr({ semanticPunctuationEnabled: event.target.checked })} />语义断句（开启后句级静音阈值不生效）</label>
        <label><input type="checkbox" checked={options.disfluencyRemovalEnabled ?? false} onChange={(event) => changeAsr({ disfluencyRemovalEnabled: event.target.checked })} />服务端过滤语气词（默认保留）</label>
        <label><input type="checkbox" checked={options.multiThresholdModeEnabled ?? false} onChange={(event) => changeAsr({ multiThresholdModeEnabled: event.target.checked })} />多阈值断句</label>
        <label><input type="checkbox" checked={options.inverseTextNormalizationEnabled ?? true} onChange={(event) => changeAsr({ inverseTextNormalizationEnabled: event.target.checked })} />数字规范化</label>
        <p>句级断句不等于发送。自动听说仍等待本机发言结束判断；热词列表须先在阿里云创建。</p>
      </>}
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
