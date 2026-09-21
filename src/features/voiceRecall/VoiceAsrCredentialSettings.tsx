import { useEffect, useState } from "react";
import { storage } from "../../services/storageAdapter";
import { formatUiError } from "../../lib/uiError";
import { voiceAsrSecretId } from "./credentials";
import type { AsrProviderProfile } from "./providerProfiles";

export const VoiceAsrCredentialSettings = ({ profile }: { profile: AsrProviderProfile }) => {
  const [key, setKey] = useState("");
  const [secondaryKey, setSecondaryKey] = useState("");
  const [status, setStatus] = useState("正在检查本机凭据…");
  const [saving, setSaving] = useState(false);
  const secretId = voiceAsrSecretId(profile);
  const doubao = profile.providerId === "doubao";
  const aliyunNls = profile.providerId === "aliyun-nls";
  useEffect(() => {
    let active = true;
    setKey("");
    setSecondaryKey("");
    if (!secretId) {
      setStatus("此 ASR 配置没有可用的本机凭据槽。");
      return () => { active = false; };
    }
    void storage.getAiSecret?.(secretId).then((secret) => {
      if (!active) return;
      const mode = aliyunNls ? "AppKey + 临时 Access Token" : doubao && secret?.apiKeySecondary?.trim() ? "旧版 App ID + Access Token" : "API Key";
      setStatus(secret?.apiKey?.trim() ? `已配置 ${profile.providerName} 凭据（${mode}，仅保存在本机）` : `尚未配置 ${profile.providerName} 凭据`);
    }).catch((error) => { if (active) setStatus(formatUiError(error, "voice-recall")); });
    return () => { active = false; };
  }, [aliyunNls, doubao, profile.providerName, secretId]);
  const save = async () => {
    if (!key.trim() || (aliyunNls && !secondaryKey.trim()) || !secretId || saving) return;
    setSaving(true);
    try {
      if (!storage.saveAiSecret) throw new Error("本机凭据存储不可用");
      await storage.saveAiSecret(key.trim(), secretId, secondaryKey.trim() || undefined);
      setKey("");
      setSecondaryKey("");
      setStatus(`已保存 ${profile.providerName} 凭据到本机。开始语音复述时会使用它。`);
    } catch (error) { setStatus(formatUiError(error, "voice-recall")); } finally { setSaving(false); }
  };
  return <section className="vr-disclosure">
    <label>{aliyunNls ? "项目 AppKey" : doubao ? "API Key / 旧版 App ID" : "阿里云 API Key"}<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} /></label>
    {doubao && <label>旧版 Access Token（可选）<input aria-label="旧版 Access Token（可选）" type="password" autoComplete="off" value={secondaryKey} onChange={(event) => setSecondaryKey(event.target.value)} /><small>新版控制台只填上方 API Key；旧版鉴权同时填写 App ID 和 Access Token。</small></label>}
    {aliyunNls && <label>Access Token<input aria-label="Access Token" type="password" autoComplete="off" value={secondaryKey} onChange={(event) => setSecondaryKey(event.target.value)} /><small>控制台生成的测试 Token 仅有效 24 小时；过期后需重新生成并保存。不要填写 AccessKey Secret。</small></label>}
    <button type="button" disabled={!key.trim() || (aliyunNls && !secondaryKey.trim()) || !secretId || saving} onClick={() => void save()}>保存 ASR 凭据</button><p role="status">{status}</p>
  </section>;
};
