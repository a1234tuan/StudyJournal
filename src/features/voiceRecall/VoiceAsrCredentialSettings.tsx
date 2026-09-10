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
      if (active) setStatus(secret?.apiKey?.trim() ? "已配置阿里云 ASR 密钥（仅保存在本机）" : "尚未配置阿里云 ASR 密钥");
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
      setStatus("已保存阿里云 ASR 密钥到本机。开始语音复述时会使用它。");
    } catch (error) { setStatus(formatUiError(error, "voice-recall")); } finally { setSaving(false); }
  };
  return <section className="vr-disclosure"><label>阿里云 ASR 本机密钥<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} /></label><button type="button" disabled={!key.trim() || saving} onClick={() => void save()}>保存 ASR 密钥</button><p role="status">{status}</p></section>;
};
