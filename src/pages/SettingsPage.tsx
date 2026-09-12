import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../types";
import { PageHeader } from "../components/ui";
import { isDesktopPlatform } from "../lib/platform";
import type { VisualTheme } from "../lib/visualTheme";
import { normalizeUiError } from "../lib/uiError";

interface SettingsPageProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
  visualTheme: VisualTheme;
  onVisualThemeChange: (theme: VisualTheme) => void;
}

export const SettingsPage = ({ settings, onSaveSettings, visualTheme, onVisualThemeChange }: SettingsPageProps) => {
  const isDesktop = isDesktopPlatform();
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyStatus, setProxyStatus] = useState("");
  const statusTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!isDesktop) return;
    void window.studyJournalDesktop!.proxy.getProxy().then(({ proxyUrl: url }) => setProxyUrl(url));
  }, [isDesktop]);

  const saveProxy = async () => {
    try {
      await window.studyJournalDesktop!.proxy.setProxy(proxyUrl);
      setProxyStatus("已保存。");
    } catch {
      setProxyStatus("保存失败，请检查地址格式（如 http://127.0.0.1:7890）。");
    }
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setProxyStatus(""), 3000);
  };

  const testFirebaseStorage = async () => {
    try {
      const { proxy, status } = await window.studyJournalDesktop!.proxy.testFirebaseStorage();
      setProxyStatus(`Firebase Storage 可连接（HTTP ${status}，${proxy}）。`);
    } catch (error) {
      const normalized = normalizeUiError(error, "cloud-sync");
      setProxyStatus(`Firebase Storage 暂时无法连接，请检查代理与网络。（诊断编号 ${normalized.diagnosticId}）`);
    }
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setProxyStatus(""), 10_000);
  };

  return (
    <main className="page settings-page">
      <PageHeader eyebrow="Settings" title="设置" density="compact" />
      <section className="settings-panel">
        <fieldset className="visual-theme-fieldset">
          <legend>视觉风格</legend>
          <div className="visual-theme-options">
            <button type="button" aria-pressed={visualTheme === "reading"} onClick={() => onVisualThemeChange("reading")}>
              <span className="visual-theme-preview visual-theme-preview-reading" />
              <span><strong>温润阅读</strong><small>暖白、舒展排版与陶土强调</small></span>
            </button>
            <button type="button" aria-pressed={visualTheme === "modern"} onClick={() => onVisualThemeChange("modern")}>
              <span className="visual-theme-preview visual-theme-preview-modern" />
              <span><strong>清爽现代</strong><small>中性明亮、紧凑层级与克制绿色</small></span>
            </button>
          </div>
          <small className="settings-hint">仅保存在当前设备，不参与云同步。</small>
        </fieldset>
        <label>
          目标日期
          <input
            type="date"
            value={settings.examDate}
            onChange={(event) => onSaveSettings({ ...settings, examDate: event.target.value })}
          />
        </label>
        <label>
          明暗模式
          <select
            value={settings.theme}
            onChange={(event) => onSaveSettings({ ...settings, theme: event.target.value as AppSettings["theme"] })}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label>
          界面字号
          <input
            type="range"
            min={0.9}
            max={1.25}
            step={0.05}
            value={settings.fontScale}
            onChange={(event) => onSaveSettings({ ...settings, fontScale: Number(event.target.value) })}
          />
        </label>
        <label>
          正文字号
          <input
            type="range"
            min={0.9}
            max={1.25}
            step={0.05}
            value={settings.editorFontScale ?? 1}
            onChange={(event) => onSaveSettings({ ...settings, editorFontScale: Number(event.target.value) })}
          />
        </label>
        <label>
          行距
          <input
            type="range"
            min={1.4}
            max={2}
            step={0.05}
            value={settings.lineHeight}
            onChange={(event) => onSaveSettings({ ...settings, lineHeight: Number(event.target.value) })}
          />
        </label>
      </section>
      {isDesktop && (
        <section className="settings-panel">
          <h3>网络代理</h3>
          <p className="settings-hint">
            填写本地代理地址（如 Clash、V2Ray 的 HTTP 代理端口），让软件的云同步流量走该代理。留空则使用系统代理设置。
          </p>
          <label>
            代理地址
            <input
              type="text"
              placeholder="http://127.0.0.1:7890"
              value={proxyUrl}
              onChange={(event) => setProxyUrl(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void saveProxy(); }}
            />
          </label>
          <div className="settings-row">
            <button onClick={() => void saveProxy()}>保存代理</button>
            <button className="secondary-button" onClick={() => void testFirebaseStorage()}>测试 Firebase 连接</button>
            {proxyStatus && <span className="settings-status">{proxyStatus}</span>}
          </div>
        </section>
      )}
    </main>
  );
};
