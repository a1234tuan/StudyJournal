import { ArrowUpRight, Image as ImageIcon, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { Asset, RecordBlock } from "../types";
import { formatUiError } from "../lib/uiError";
import { PageHeader } from "../components/ui";

export type OcrDashboardStatus = "idle" | "queued" | "running" | "failed" | "timeout";

export interface OcrDashboardItem {
  key: string;
  record: RecordBlock;
  asset: Asset;
  status: OcrDashboardStatus;
}

export const OCR_STATUS_LABELS: Record<OcrDashboardStatus, string> = {
  idle: "未识别",
  queued: "排队中",
  running: "识别中",
  failed: "失败",
  timeout: "超时",
};

export const buildOcrDashboardItems = (records: readonly RecordBlock[], assets: readonly Asset[]): OcrDashboardItem[] => {
  const assetsById = new Map(assets.filter((asset) => asset.kind === "image").map((asset) => [asset.id, asset]));
  const seen = new Set<string>();
  return records
    .flatMap((record) => record.assets
      .filter((ref) => ref.kind === "image")
      .map((ref): OcrDashboardItem | undefined => {
        const asset = assetsById.get(ref.id);
        if (!asset || asset.ocrStatus === "done") {
          return undefined;
        }
        const key = `${record.id}:${asset.id}`;
        if (seen.has(key)) {
          return undefined;
        }
        seen.add(key);
        return {
          key,
          record,
          asset,
          status: asset.ocrStatus ?? "idle",
        } satisfies OcrDashboardItem;
      })
      .filter((item): item is OcrDashboardItem => Boolean(item)))
    .sort((left, right) => right.record.date.localeCompare(left.record.date) || left.record.order - right.record.order || left.key.localeCompare(right.key));
};

interface OcrDashboardPageProps {
  records: readonly RecordBlock[];
  assets: readonly Asset[];
  onRetry: (assetId: string) => Promise<void>;
  onOpenRecord?: (record: RecordBlock, assetId: string) => void;
}

export const OcrDashboardPage = ({ records, assets, onRetry, onOpenRecord }: OcrDashboardPageProps) => {
  const items = buildOcrDashboardItems(records, assets);
  const [retrying, setRetrying] = useState<Set<string>>(() => new Set());
  const [messages, setMessages] = useState<Record<string, string>>({});

  const retry = async (item: OcrDashboardItem) => {
    setRetrying((current) => new Set(current).add(item.asset.id));
    setMessages((current) => ({ ...current, [item.key]: "正在重新识别…" }));
    try {
      await onRetry(item.asset.id);
      setMessages((current) => ({ ...current, [item.key]: "已完成 OCR。" }));
    } catch (error) {
      setMessages((current) => ({ ...current, [item.key]: formatUiError(error, "generic") }));
    } finally {
      setRetrying((current) => {
        const next = new Set(current);
        next.delete(item.asset.id);
        return next;
      });
    }
  };

  return (
    <main className="page ocr-dashboard-page">
      <PageHeader
        eyebrow="OCR"
        title="OCR 失败看板"
        subtitle="集中查看仍未完成的图片识别任务。识别成功的图片会自动从这里移除。"
        density="compact"
      />

      {items.length === 0 ? (
        <section className="ocr-dashboard-empty">
          <ImageIcon size={28} aria-hidden="true" />
          <h2>没有待处理的图片</h2>
          <p>当前所有日志图片都已完成 OCR，或还没有引用图片。</p>
        </section>
      ) : (
        <section className="ocr-dashboard-list" aria-label="待处理 OCR 图片">
          <p className="helper-text">共 {items.length} 张图片待处理</p>
          {items.map((item) => {
            const busy = retrying.has(item.asset.id);
            return (
              <article className="ocr-dashboard-item" key={item.key}>
                <div className="ocr-dashboard-item-icon"><ImageIcon size={19} aria-hidden="true" /></div>
                <div className="ocr-dashboard-item-content">
                  <h2>{item.record.title}</h2>
                  <p>{item.record.date} · {item.record.subject}</p>
                  <p className="ocr-dashboard-asset-name">图片：{item.asset.title || item.asset.fileName}</p>
                  <p className={`ocr-dashboard-status ocr-dashboard-status-${item.status}`}>
                    {OCR_STATUS_LABELS[item.status]}
                    {item.asset.ocrError ? ` · ${item.asset.ocrError}` : ""}
                  </p>
                  {messages[item.key] && <p className="status-message">{messages[item.key]}</p>}
                </div>
                <div className="ocr-dashboard-item-actions">
                  {onOpenRecord && (
                    <button type="button" className="secondary-button" onClick={() => onOpenRecord(item.record, item.asset.id)}>
                      <ArrowUpRight size={16} />
                      打开日志
                    </button>
                  )}
                  <button type="button" className="primary-button" onClick={() => void retry(item)} disabled={busy}>
                    <RefreshCw size={16} />
                    {busy ? "识别中…" : "重新 OCR"}
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
};
