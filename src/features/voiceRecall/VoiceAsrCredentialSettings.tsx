import { useEffect, useState } from "react";
import { storage } from "../../services/storageAdapter";
import { formatUiError } from "../../lib/uiError";

export const VoiceAsrCredentialSettings = () => {
  const [key, setKey] = useState("");
  const [status, setStatus] = useState("正在检查本机凭据…");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void storage.getAiSecret?.("voice-asr-aliyun").then((secret) => {
      if (active) setStatus(secret?.apiKey?.trim() ? "本机已配置 ASR 密钥（未验证权限）" : "尚未配置 ASR 密钥");
    }).catch((error) => { if (active) setStatus(formatUiError(error, "voice-recall")); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    if (!key.trim() || saving) return;
    setSaving(true);
    try {
      if (!storage.saveAiSecret) throw new Error("本机凭据存储不可用");
      await storage.saveAiSecret(key.trim(), "voice-asr-aliyun");
      setKey("");
      setStatus("已保存至本机，未调用真实服务。请仅使用轮换后的新密钥。");
    } catch (error) { setStatus(formatUiError(error, "voice-recall")); } finally { setSaving(false); }
  };
  return <section className="vr-disclosure"><label>阿里云 ASR 本机密钥<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} /></label><button type="button" disabled={!key.trim() || saving} onClick={() => void save()}>保存 ASR 密钥</button><p role="status">{status}</p></section>;
};
