import { Eye, EyeOff, Save } from "lucide-react";
import { useEffect, useState } from "react";

import type { Asset, RecordBlock } from "../types";
import { getPaddleOcrToken, savePaddleOcrToken } from "../services/ocrSettings";
import { PageHeader } from "../components/ui";
import { formatUiError } from "../lib/uiError";
import { OcrDashboardPanel } from "./OcrDashboardPage";

interface OcrSettingsPageProps {
  records: readonly RecordBlock[];
  assets: readonly Asset[];
  onChanged: () => Promise<void> | void;
  onRetry: (assetId: string) => Promise<void>;
  onOpenRecord?: (record: RecordBlock, assetId: string) => void;
}

export const OcrSettingsPage = ({ records, assets, onChanged, onRetry, onOpenRecord }: OcrSettingsPageProps) => {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getPaddleOcrToken()
      .then((value) => {
        if (!cancelled) {
          setToken(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setToken("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      await savePaddleOcrToken(token);
      await onChanged();
      setMessage("OCR 设置已保存。Token 只保存在本机，不进入完整备份。");
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="page ocr-settings-page">
      <PageHeader
        eyebrow="OCR"
        title="OCR 设置"
        subtitle="配置 PaddleOCR，用于图片文字识别、本地全文检索和 AI 图片问答。"
        density="compact"
      />

      <section className="settings-panel ocr-settings-panel">
        <label>
          PaddleOCR Token
          <span className="secret-input">
            <input
              value={token}
              type={showToken ? "text" : "password"}
              onChange={(event) => setToken(event.target.value)}
              placeholder="在 PaddleOCR / AI Studio 控制台获取后填写"
            />
            <button type="button" onClick={() => setShowToken((value) => !value)} aria-label="切换 PaddleOCR Token 显示">
              {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </span>
        </label>
        <p className="helper-text">Token 只存本机，不进入完整备份。配置后可用于图片 OCR 检索和 AI 图片问答。</p>
        <button type="button" className="primary-button" onClick={() => void save()} disabled={saving}>
          <Save size={18} />
          {saving ? "保存中..." : "保存 OCR 设置"}
        </button>
        {message && <p className="status-message">{message}</p>}
      </section>

      <section className="settings-panel ocr-settings-panel">
        <header>
          <p className="eyebrow">OCR 任务</p>
          <h2>任务状态</h2>
          <p className="helper-text">查看未识别、排队中、失败或超时的图片，并从这里重新识别。</p>
        </header>
        <OcrDashboardPanel records={records} assets={assets} onRetry={onRetry} onOpenRecord={onOpenRecord} />
      </section>
    </main>
  );
};
