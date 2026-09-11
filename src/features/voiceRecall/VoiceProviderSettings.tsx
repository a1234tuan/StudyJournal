import type { VoiceRecallProviderSetup } from "./VoiceRecallPresentation";
import { VoiceAsrCredentialSettings } from "./VoiceAsrCredentialSettings";

export const VoiceProviderSettings = ({ setup }: { setup: VoiceRecallProviderSetup }) => {
  const config = setup.config;
  const summary = setup.summaries[setup.selectedTemplateId];
  const options = config.asrOptions ?? {};
  const change = (patch: Partial<typeof config>) => setup.onConfigChange({ ...config, ...patch });
  const changeAsr = (patch: Partial<typeof options>) => change({ asrOptions: { ...options, ...patch } });
  return <section className="vr-provider-body" aria-label="本机语音服务配置">
    <details><summary>ASR：{summary?.asr ?? "阿里云"}</summary>
      <VoiceAsrCredentialSettings />
      <label>模型<input value={config.asrModel} onChange={(event) => change({ asrModel: event.target.value })} /></label>
      <label>语言提示<input aria-label="ASR 语言提示" value={(options.languageHints ?? ["zh", "en"]).join(",")} onChange={(event) => changeAsr({ languageHints: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></label>
      <label>热词列表 ID<input value={options.vocabularyId ?? ""} onChange={(event) => changeAsr({ vocabularyId: event.target.value })} placeholder="已有阿里云词表 ID" /></label>
      <label>句级静音（毫秒）<input type="number" min={200} max={6000} value={options.maxSentenceSilence ?? 1300} onChange={(event) => changeAsr({ maxSentenceSilence: Number(event.target.value) })} /></label>
      <label><input type="checkbox" checked={options.semanticPunctuationEnabled ?? false} onChange={(event) => changeAsr({ semanticPunctuationEnabled: event.target.checked })} />语义断句（开启后句级静音阈值不生效）</label>
      <label><input type="checkbox" checked={options.disfluencyRemovalEnabled ?? false} onChange={(event) => changeAsr({ disfluencyRemovalEnabled: event.target.checked })} />服务端过滤语气词（默认保留）</label>
      <label><input type="checkbox" checked={options.multiThresholdModeEnabled ?? false} onChange={(event) => changeAsr({ multiThresholdModeEnabled: event.target.checked })} />多阈值断句</label>
      <label><input type="checkbox" checked={options.inverseTextNormalizationEnabled ?? true} onChange={(event) => changeAsr({ inverseTextNormalizationEnabled: event.target.checked })} />数字规范化</label>
      <p>句级断句不等于发送。自动听说仍等待本机发言结束判断；热词列表须先在阿里云创建。</p>
    </details>
    <details><summary>LLM：{summary?.llm.split(" · ")[0] ?? "当前 AI 配置"}</summary>
      <p>复用“更多 → AI 设置”的当前配置及其本机密钥。更换供应商请在该配置中心选择。</p>
      <label>模型<input value={config.llmModel} onChange={(event) => change({ llmModel: event.target.value })} /></label>
      <label>服务端点<input value={config.llmBaseUrl} readOnly /></label>
    </details>
    <details><summary>TTS：{summary?.tts.split(" · ")[0] ?? "Fish Audio"}</summary>
      <p>复用“更多 → TTS 设置”的 Fish Audio 配置。尚未接通的供应商不会出现在通话选择中。</p>
      <label>模型<input value={config.ttsModel} onChange={(event) => change({ ttsModel: event.target.value })} /></label>
      <label>音色 ID<input value={config.ttsVoice} onChange={(event) => change({ ttsVoice: event.target.value })} /></label>
    </details>
  </section>;
};
