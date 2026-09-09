import { ChevronDown, Eye, EyeOff, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useMemo, useState } from "react";

import type { AiProviderConfig, AiProviderProfile, AiPromptPreset, AppSettings } from "../types";
import { createBaseEntity } from "../lib/entity";
import { createDefaultAiPresets, DEFAULT_SETTINGS } from "../db/defaults";
import {
  DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
  createAiProviderTemplate,
  getCurrentAiProvider,
  normalizeAiConfig,
  normalizeAiProvider,
} from "../lib/aiProviders";
import { normalizeAiChatCompletionsUrl, testAiProviderConnection } from "../services/aiClientService";
import { storage } from "../services/storageAdapter";
import { formatUiError } from "../lib/uiError";

interface AiSettingsPanelProps {
  settings: AppSettings;
  onChanged: () => Promise<void> | void;
}

const withAiDefaults = (settings: AppSettings): AiProviderConfig =>
  normalizeAiConfig(settings.ai, settings.ai?.presets?.length ? settings.ai.presets : createDefaultAiPresets());

const sortedPresets = (presets: AiPromptPreset[]) =>
  [...presets].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));

const previewChatCompletionsUrl = (baseUrl: string): string => {
  try {
    return normalizeAiChatCompletionsUrl(baseUrl);
  } catch {
    return "请先填写 Base URL";
  }
};

const shouldShowCustomProxyV1Hint = (provider: AiProviderProfile): boolean => {
  const trimmed = provider.baseUrl.trim().replace(/\/+$/, "");
  return provider.builtIn === "custom-proxy" && /^https?:\/\/[^/]+$/i.test(trimmed);
};

const providerTemplates: Array<{ builtIn: NonNullable<AiProviderProfile["builtIn"]>; label: string }> = [
  { builtIn: "deepseek", label: "DeepSeek" },
  { builtIn: "nvidia", label: "NVIDIA" },
  { builtIn: "aliyun", label: "阿里云百炼" },
  { builtIn: "custom-proxy", label: "自定义中转 API" },
];

const imageInputModeOptions: Array<{
  value: NonNullable<AiProviderConfig["imageInputMode"]>;
  label: string;
  description: string;
}> = [
  {
    value: "local-ocr",
    label: "本地 OCR 后转文字",
    description: "适合不支持看图的文本模型，发送图片前先识别图片文字，再把 Markdown 文本发给 AI。",
  },
  {
    value: "vision",
    label: "直接发送给 AI",
    description: "适合支持图片输入的模型。若接口报错，请切回本地 OCR。",
  },
  {
    value: "disabled",
    label: "关闭图片发送",
    description: "聊天输入区仍保留文字问答，不允许发送图片。",
  },
];

export const AiSettingsPanel = ({ settings, onChanged }: AiSettingsPanelProps) => {
  const [config, setConfig] = useState<AiProviderConfig>(() => withAiDefaults(settings));
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  // Only providers whose key was actually read (or explicitly edited) may have
  // their secret written or cleared; otherwise saving before the async load
  // finishes silently deletes a stored key.
  const [loadedKeyIds, setLoadedKeyIds] = useState<Set<string>>(() => new Set());
  const [dirtyKeyIds, setDirtyKeyIds] = useState<Set<string>>(() => new Set());
  const editedKeys = useRef(new Set<string>());
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const presets = useMemo(() => sortedPresets(config.presets), [config.presets]);
  const currentProvider = getCurrentAiProvider(config);

  useEffect(() => {
    let active = true;
    editedKeys.current = new Set();
    const nextConfig = withAiDefaults(settings);
    setConfig(nextConfig);
    setLoadedKeyIds(new Set());
    setDirtyKeyIds(new Set());
    void Promise.all(
      nextConfig.providers.map(async (provider) => [provider.id, (await storage.getAiSecret?.(provider.id))?.apiKey ?? ""] as const),
    )
      .then((entries) => {
        if (!active) return;
        setApiKeys((current) => ({ ...current, ...Object.fromEntries(entries.filter(([id]) => !editedKeys.current.has(id))) }));
        setLoadedKeyIds(new Set(entries.map(([id]) => id)));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [settings]);

  const updateProvider = (id: string, patch: Partial<AiProviderProfile>) => {
    setConfig((current) => ({
      ...current,
      providers: current.providers.map((provider) =>
        provider.id === id ? { ...provider, ...patch, id: provider.id } : provider,
      ),
    }));
  };

  const addProviderFromTemplate = (builtIn: NonNullable<AiProviderProfile["builtIn"]>) => {
    const provider = createAiProviderTemplate(builtIn);
    setConfig((current) => ({
      ...current,
      currentProviderId: provider.id,
      providers: [...current.providers, provider],
    }));
    setApiKeys((current) => ({ ...current, [provider.id]: "" }));
    setDirtyKeyIds((current) => new Set(current).add(provider.id));
  };

  const removeProvider = (id: string) => {
    if (config.currentProviderId === id) {
      setMessage("当前正在使用的供应商不能删除，请先切换到其他供应商。");
      return;
    }
    setConfig((current) => ({
      ...current,
      providers: current.providers.filter((provider) => provider.id !== id),
    }));
    setApiKeys((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const save = async () => {
    setMessage("");
    const providers = config.providers.map((provider) => normalizeAiProvider(provider));
    const currentProviderId = providers.some((provider) => provider.id === config.currentProviderId)
      ? config.currentProviderId
      : providers[0]?.id;
    if (!currentProviderId || providers.length === 0) {
      setMessage("请至少保留一个 AI 供应商。");
      return;
    }
    const incompleteProvider = providers.find((provider) =>
      !provider.providerName.trim() || !provider.baseUrl.trim() || !provider.model.trim());
    if (incompleteProvider) {
      setMessage(`请补齐 ${incompleteProvider.providerName || "未命名供应商"} 的供应商名称、Base URL 和模型名称后再保存。`);
      return;
    }
    const nextConfig: AiProviderConfig = {
      ...config,
      currentProviderId,
      providers,
      presets: sortedPresets(config.presets).map((preset, order) => ({ ...preset, order })),
    };
    await storage.saveSettings({ ...settings, ai: nextConfig });
    await Promise.all(
      providers.map((provider) => {
        if (!loadedKeyIds.has(provider.id) && !dirtyKeyIds.has(provider.id)) return Promise.resolve();
        const key = apiKeys[provider.id]?.trim();
        return key ? storage.saveAiSecret?.(key, provider.id) : storage.clearAiSecret?.(provider.id);
      }),
    );
    await onChanged();
    setMessage("AI 设置已保存。API Key 只保存在本机，不进入备份。");
  };

  const testProvider = async (provider: AiProviderProfile) => {
    const normalizedProvider = normalizeAiProvider(provider);
    const requestUrl = previewChatCompletionsUrl(normalizedProvider.baseUrl);
    setMessage("");
    setTestResults((current) => ({ ...current, [provider.id]: "正在测试连接..." }));
    setTestingProviderId(provider.id);
    try {
      const result = await testAiProviderConnection({
        provider: normalizedProvider,
        apiKey: apiKeys[provider.id],
      });
      const content = result.content ? `返回：${result.content.slice(0, 80)}` : "接口已返回有效响应。";
      setTestResults((current) => ({
        ...current,
        [provider.id]: `连接成功。请求地址：${result.requestUrl}。${content}`,
      }));
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [provider.id]: `测试失败。请求地址：${requestUrl}。${formatUiError(error, "ai-request")}`,
      }));
    } finally {
      setTestingProviderId(null);
    }
  };

  const updatePreset = (id: string, patch: Partial<AiPromptPreset>) => {
    setConfig((current) => ({
      ...current,
      presets: current.presets.map((preset) => (preset.id === id ? { ...preset, ...patch } : preset)),
    }));
  };

  const addPreset = () => {
    const preset: AiPromptPreset = {
      ...createBaseEntity(),
      title: "新预设",
      prompt: "请根据今天日志...",
      mode: "custom",
      order: config.presets.length,
    };
    setConfig((current) => ({ ...current, presets: [...current.presets, preset] }));
  };

  const removePreset = (id: string) => {
    setConfig((current) => ({ ...current, presets: current.presets.filter((preset) => preset.id !== id) }));
  };

  return (
    <section className="ai-settings-panel">
      <button type="button" className="ai-settings-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>
          <strong>AI 设置</strong>
          <small>配置多个 OpenAI 兼容供应商、API Key 和预设提示词</small>
        </span>
        <ChevronDown size={17} />
      </button>

      {open && (
        <div className="ai-settings-body">
          <header className="inline-section-header">
            <div>
              <h3>供应商档案</h3>
              <p>可保存 DeepSeek、NVIDIA、阿里云百炼或第三方中转 API，聊天时使用当前选中的档案。</p>
            </div>
          </header>

          <div className="provider-template-row">
            {providerTemplates.map((template) => (
              <button key={template.builtIn} type="button" className="secondary-button" onClick={() => addProviderFromTemplate(template.builtIn)}>
                <Plus size={16} />
                {template.label}
              </button>
            ))}
          </div>

          <div className="provider-profile-list">
            {config.providers.map((provider) => {
              const active = provider.id === config.currentProviderId;
              return (
                <article key={provider.id} className={`provider-profile-card ${active ? "active" : ""}`}>
                  <header>
                    <button
                      type="button"
                      className={active ? "primary-button" : "secondary-button"}
                      onClick={() => setConfig((current) => ({ ...current, currentProviderId: provider.id }))}
                    >
                      {active ? "当前使用" : "设为当前"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void testProvider(provider)}
                      disabled={testingProviderId === provider.id}
                    >
                      <RefreshCw size={16} />
                      {testingProviderId === provider.id ? "测试中" : "测试连接"}
                    </button>
                    <button type="button" className="icon-button danger" onClick={() => removeProvider(provider.id)} disabled={active}>
                      <Trash2 size={16} />
                    </button>
                  </header>
                  <div className="settings-grid">
                    <label>
                      供应商名称
                      <input
                        value={provider.providerName}
                        onChange={(event) => updateProvider(provider.id, { providerName: event.target.value })}
                        placeholder="DeepSeek / NVIDIA / 阿里云百炼"
                      />
                    </label>
                    <label>
                      Base URL
                      <input
                        value={provider.baseUrl}
                        onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })}
                        placeholder={DEFAULT_SETTINGS.ai?.providers[0]?.baseUrl ?? "https://api.deepseek.com"}
                      />
                      <small>实际请求地址：{previewChatCompletionsUrl(provider.baseUrl)}</small>
                      {shouldShowCustomProxyV1Hint(provider) && (
                        <small>多数中转站需要在 Base URL 末尾加 /v1，例如 https://chatapi.onechats.top/v1。</small>
                      )}
                    </label>
                    <label>
                      模型
                      <input
                        value={provider.model}
                        onChange={(event) => updateProvider(provider.id, { model: event.target.value })}
                        placeholder="deepseek-v4-pro / qwen-plus / meta/llama-3.3-70b-instruct"
                      />
                    </label>
                    <label>
                      API Key
                      <span className="secret-input">
                        <input
                          value={apiKeys[provider.id] ?? ""}
                          type={showKey ? "text" : "password"}
                          onChange={(event) => {
                            editedKeys.current.add(provider.id);
                            setApiKeys((current) => ({ ...current, [provider.id]: event.target.value }));
                            setDirtyKeyIds((current) => new Set(current).add(provider.id));
                          }}
                          placeholder="sk-... / nvapi-..."
                        />
                        <button type="button" onClick={() => setShowKey((value) => !value)} aria-label="切换密钥显示">
                          {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                        </button>
                      </span>
                    </label>
                    <label>
                      Temperature
                      <input
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        value={provider.temperature}
                        onChange={(event) => updateProvider(provider.id, { temperature: Number(event.target.value) })}
                      />
                    </label>
                    <label>
                      Max Tokens
                      <input
                        type="number"
                        min="256"
                        step="256"
                        value={provider.maxTokens}
                        onChange={(event) => updateProvider(provider.id, { maxTokens: Number(event.target.value) })}
                      />
                    </label>
                    <label>
                      Context Window Tokens
                      <input
                        type="number"
                        min="4096"
                        step="1024"
                        value={provider.contextWindowTokens ?? DEFAULT_AI_CONTEXT_WINDOW_TOKENS}
                        onChange={(event) => updateProvider(provider.id, { contextWindowTokens: Number(event.target.value) })}
                      />
                      <small>模型输入与输出共享的上下文窗口，用于限制知识库检索内容。</small>
                    </label>
                    <label>
                      上下文记忆
                      <input value={`最近 ${provider.memoryTurns ?? 12} 轮问答`} readOnly />
                    </label>
                  </div>
                  {testResults[provider.id] && <p className="helper-text">{testResults[provider.id]}</p>}
                </article>
              );
            })}
          </div>

          {currentProvider && <p className="helper-text">当前供应商：{currentProvider.providerName} / {currentProvider.model || "未填写模型"}</p>}

          <section className="ai-image-mode-card">
            <header className="inline-section-header">
              <div>
                <h3>图片问答方式</h3>
                <p>由你判断当前模型是否支持图片；选择本地 OCR 时，会使用“更多 / OCR 设置”中的 PaddleOCR 配置。</p>
              </div>
            </header>
            <div className="ai-image-mode-options">
              {imageInputModeOptions.map((option) => (
                <label key={option.value} className={(config.imageInputMode ?? "local-ocr") === option.value ? "active" : ""}>
                  <input
                    type="radio"
                    name="ai-image-input-mode"
                    value={option.value}
                    checked={(config.imageInputMode ?? "local-ocr") === option.value}
                    onChange={() => setConfig((current) => ({ ...current, imageInputMode: option.value }))}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <header className="inline-section-header">
            <div>
              <h3>预设提示词</h3>
              <p>聊天页可一键填入，发送前还能继续修改。</p>
            </div>
            <button type="button" className="secondary-button" onClick={addPreset}>
              <Plus size={16} />
              新增
            </button>
          </header>

          <div className="preset-editor-list">
            {presets.map((preset) => (
              <article key={preset.id} className="preset-editor-card">
                <input
                  value={preset.title}
                  onChange={(event) => updatePreset(preset.id, { title: event.target.value })}
                  aria-label="预设标题"
                />
                <textarea
                  value={preset.prompt}
                  onChange={(event) => updatePreset(preset.id, { prompt: event.target.value })}
                  aria-label="预设提示词"
                  rows={3}
                />
                <select
                  value={preset.mode ?? "custom"}
                  onChange={(event) => updatePreset(preset.id, { mode: event.target.value as AiPromptPreset["mode"] })}
                  aria-label="预设模式"
                >
                  <option value="recall">白纸复述</option>
                  <option value="application">变形应用</option>
                  <option value="trap">盲区挖掘</option>
                  <option value="feynman">费曼讲解</option>
                  <option value="correction">理解纠偏</option>
                  <option value="custom">自定义</option>
                </select>
                <button type="button" className="icon-button danger" onClick={() => removePreset(preset.id)}>
                  <Trash2 size={16} />
                </button>
              </article>
            ))}
          </div>

          <button type="button" className="primary-button" onClick={save}>
            <Save size={18} />
            保存 AI 设置
          </button>
          {message && <p className="status-message">{message}</p>}
        </div>
      )}
    </section>
  );
};
