import { ChevronDown, Eye, EyeOff, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { AppSettings, TtsProviderConfig, TtsProviderId, TtsProviderProfile } from "../types";
import {
  createTtsProviderTemplate,
  getCurrentTtsProvider,
  normalizeTtsConfig,
  ttsProviderNeedsSecondaryKey,
} from "../lib/ttsProviders";
import { storage } from "../services/storageAdapter";

interface TtsSettingsPanelProps {
  settings: AppSettings;
  onChanged: () => Promise<void> | void;
}

const PROVIDER_TEMPLATES: Array<{ providerId: TtsProviderId; label: string; patch?: Partial<TtsProviderProfile> }> = [
  { providerId: "fish-audio", label: "Fish Audio" },
  { providerId: "aliyun", label: "阿里云百炼" },
  { providerId: "tencent", label: "腾讯云" },
  { providerId: "google", label: "Google Cloud" },
  {
    providerId: "doubao",
    label: "豆包语音 2.0（Tina老师）",
    patch: { providerName: "豆包语音 2.0", model: "seed-tts-2.0", voice: "zh_female_yingyujiaoxue_uranus_bigtts" },
  },
  {
    providerId: "doubao",
    label: "豆包语音 1.0（暖心学姐）",
    patch: { providerName: "豆包语音 1.0", model: "seed-tts-1.0", voice: "ICL_zh_female_nuanxinxuejie_tob" },
  },
];

export const TtsSettingsPanel = ({ settings, onChanged }: TtsSettingsPanelProps) => {
  const [open, setOpen] = useState(true);
  const [config, setConfig] = useState<TtsProviderConfig>(() => normalizeTtsConfig(settings.tts));
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  // See AiSettingsPanel: never write or clear a secret that was not loaded or edited.
  const [loadedKeyIds, setLoadedKeyIds] = useState<Set<string>>(() => new Set());
  const [dirtyKeyIds, setDirtyKeyIds] = useState<Set<string>>(() => new Set());
  const [secondaryKeys, setSecondaryKeys] = useState<Record<string, string>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState("");

  useEffect(() => {
    const nextConfig = normalizeTtsConfig(settings.tts);
    setConfig(nextConfig);
    setLoadedKeyIds(new Set());
    setDirtyKeyIds(new Set());
    void Promise.all(
      nextConfig.providers.map(async (p) => {
        const secret = await storage.getAiSecret?.(p.id);
        return [p.id, secret] as const;
      }),
    )
      .then((entries) => {
        setApiKeys(Object.fromEntries(entries.map(([id, s]) => [id, s?.apiKey ?? ""])));
        setSecondaryKeys(Object.fromEntries(entries.map(([id, s]) => [id, s?.apiKeySecondary ?? ""])));
        setLoadedKeyIds(new Set(entries.map(([id]) => id)));
      })
      .catch(() => {
        setApiKeys(Object.fromEntries(nextConfig.providers.map((p) => [p.id, ""])));
        setSecondaryKeys(Object.fromEntries(nextConfig.providers.map((p) => [p.id, ""])));
      });
  }, [settings]);

  const updateProvider = (id: string, patch: Partial<TtsProviderProfile>) => {
    setConfig((current) => ({
      ...current,
      providers: current.providers.map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p)),
    }));
  };

  const addProvider = (providerId: TtsProviderId, patch?: Partial<TtsProviderProfile>) => {
    const profile = { ...createTtsProviderTemplate(providerId), ...patch };
    setConfig((current) => ({
      ...current,
      currentProviderId: profile.id,
      providers: [...current.providers, profile],
    }));
    setApiKeys((current) => ({ ...current, [profile.id]: "" }));
    setDirtyKeyIds((current) => new Set(current).add(profile.id));
    setSecondaryKeys((current) => ({ ...current, [profile.id]: "" }));
  };

  const removeProvider = (id: string) => {
    if (config.currentProviderId === id) {
      setMessage("当前正在使用的供应商不能删除，请先切换到其他供应商。");
      return;
    }
    setConfig((current) => ({
      ...current,
      providers: current.providers.filter((p) => p.id !== id),
    }));
  };

  const save = async () => {
    setMessage("");
    const providers = config.providers;
    const currentProviderId = providers.some((p) => p.id === config.currentProviderId)
      ? config.currentProviderId
      : providers[0]?.id;
    if (!currentProviderId || providers.length === 0) {
      setMessage("请至少保留一个 TTS 供应商。");
      return;
    }
    const current = providers.find((p) => p.id === currentProviderId);
    if (current && !current.voice.trim()) {
      setMessage(`请填写 ${current.providerName} 的音色 / Voice ID。`);
      return;
    }
    const nextConfig: TtsProviderConfig = { ...config, currentProviderId, providers };
    await storage.saveSettings({ ...settings, tts: nextConfig });
    await Promise.all(
      providers.map(async (p) => {
        if (!loadedKeyIds.has(p.id) && !dirtyKeyIds.has(p.id)) return;
        const key = apiKeys[p.id]?.trim();
        const secondary = secondaryKeys[p.id]?.trim();
        if (key) await storage.saveAiSecret?.(key, p.id, secondary || undefined);
        else await storage.clearAiSecret?.(p.id);
      }),
    );
    await onChanged();
    setMessage("TTS 设置已保存。API Key 只保存在本机，不进入备份。");
  };

  const currentProfile = getCurrentTtsProvider(config);

  return (
    <section className="ai-settings-panel tts-settings-panel">
      <button type="button" className="ai-settings-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>
          <strong>文本转语音（TTS）设置</strong>
          <small>配置 Fish Audio、阿里云百炼、腾讯云、Google Cloud 或豆包语音 TTS，用于知识播客音频生成</small>
        </span>
        <ChevronDown size={17} />
      </button>

      {open && (
        <div className="ai-settings-body">
          <header className="inline-section-header">
            <div>
              <h3>TTS 供应商档案</h3>
              <p>可保存多个供应商配置，生成知识播客时使用当前选中的档案。</p>
            </div>
          </header>

          <div className="provider-template-row">
            {PROVIDER_TEMPLATES.map((template, index) => (
              <button key={`${template.providerId}-${index}`} type="button" className="secondary-button" onClick={() => addProvider(template.providerId, template.patch)}>
                <Plus size={16} />
                {template.label}
              </button>
            ))}
          </div>

          <div className="provider-profile-list">
            {config.providers.map((profile) => {
              const active = profile.id === config.currentProviderId;
              const needsSecondary = ttsProviderNeedsSecondaryKey(profile.providerId);
              const showKey = showKeys[profile.id] ?? false;
              return (
                <article key={profile.id} className={`provider-profile-card ${active ? "active" : ""}`}>
                  <header>
                    <button
                      type="button"
                      className={active ? "primary-button" : "secondary-button"}
                      onClick={() => setConfig((c) => ({ ...c, currentProviderId: profile.id }))}
                    >
                      {active ? "当前使用" : "设为当前"}
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      onClick={() => removeProvider(profile.id)}
                      disabled={active}
                    >
                      <Trash2 size={16} />
                    </button>
                  </header>

                  <div className="settings-grid">
                    <label>
                      供应商
                      <input value={profile.providerName} readOnly />
                    </label>

                    {profile.providerId !== "tencent" && (
                      <label>
                        {profile.providerId === "doubao" ? "模型 / Resource ID" : "模型"}
                        <input
                          value={profile.model}
                          onChange={(e) => updateProvider(profile.id, { model: e.target.value })}
                          placeholder={profile.providerId === "fish-audio" ? "s2.1-pro-free" : profile.providerId === "aliyun" ? "qwen3-tts-flash" : profile.providerId === "doubao" ? "seed-tts-2.0" : ""}
                        />
                      </label>
                    )}

                    <label>
                      {profile.providerId === "tencent" ? "VoiceType（数字）" : profile.providerId === "doubao" ? "Voice_Type / 音色 ID" : "音色 / Voice ID"}
                      <input
                        value={profile.voice}
                        onChange={(e) => updateProvider(profile.id, { voice: e.target.value })}
                        placeholder={
                          profile.providerId === "fish-audio" ? "Fish Audio reference_id" :
                          profile.providerId === "aliyun" ? "Cherry / Ethan / Dylan" :
                          profile.providerId === "tencent" ? "101001" :
                          profile.providerId === "doubao" ? "zh_female_yingyujiaoxue_uranus_bigtts" :
                          "cmn-CN-Wavenet-A"
                        }
                      />
                    </label>

                    {profile.providerId === "google" && (
                      <label>
                        Language Code
                        <input
                          value={profile.languageCode ?? ""}
                          onChange={(e) => updateProvider(profile.id, { languageCode: e.target.value })}
                          placeholder="cmn-CN"
                        />
                      </label>
                    )}

                    {profile.providerId === "tencent" && (
                      <label>
                        地域 Region
                        <input
                          value={profile.region ?? ""}
                          onChange={(e) => updateProvider(profile.id, { region: e.target.value })}
                          placeholder="ap-guangzhou"
                        />
                      </label>
                    )}

                    <label>
                      {needsSecondary ? "SecretId（API Key）" : "API Key"}
                      <span className="secret-input">
                        <input
                          type={showKey ? "text" : "password"}
                          value={apiKeys[profile.id] ?? ""}
                          onChange={(e) => {
                            setApiKeys((c) => ({ ...c, [profile.id]: e.target.value }));
                            setDirtyKeyIds((c) => new Set(c).add(profile.id));
                          }}
                          placeholder={profile.providerId === "fish-audio" ? "sk-..." : profile.providerId === "tencent" ? "AKIDxxxxxxxx" : "API Key"}
                        />
                        <button
                          type="button"
                          onClick={() => setShowKeys((c) => ({ ...c, [profile.id]: !showKey }))}
                          aria-label="切换密钥显示"
                        >
                          {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                        </button>
                      </span>
                    </label>

                    {needsSecondary && (
                      <label>
                        SecretKey（API Key Secondary）
                        <span className="secret-input">
                          <input
                            type={showKey ? "text" : "password"}
                            value={secondaryKeys[profile.id] ?? ""}
                            onChange={(e) => setSecondaryKeys((c) => ({ ...c, [profile.id]: e.target.value }))}
                            placeholder="腾讯云 SecretKey"
                          />
                        </span>
                      </label>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          {currentProfile && (
            <p className="helper-text">
              当前供应商：{currentProfile.providerName}
              {currentProfile.model ? ` / ${currentProfile.model}` : ""}
              {currentProfile.voice ? ` / ${currentProfile.voice}` : " / 未填写音色"}
            </p>
          )}

          {message && <p className="helper-text">{message}</p>}

          <button type="button" className="primary-button" onClick={() => void save()}>
            <Save size={17} />
            保存 TTS 设置
          </button>
        </div>
      )}
    </section>
  );
};
