import { CheckSquare, DatabaseBackup, Download, FileArchive, Square, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AppSettings, AutoBackupSettings, ExportKind, ExportProgress, ImportProgress, ImportSummary, RecordTransferPackage } from "../types";
import { exportFullBackupFromStorage } from "../services/knowledgeExportService";
import { importAndRestoreSnapshot } from "../services/importRestoreService";
import { nativeBackupAdapter, pickNativeZipFile } from "../services/nativeBackupAdapter";
import { createNativeRepository, restoreNativeRepositoryBackup } from "../services/nativeRepositoryBackupService";
import { currentKnowledgeBackupDirectory } from "../features/knowledgeLibrary/autoBackup";
import { storage } from "../services/storageAdapter";
import { manualZipSyncAdapter } from "../services/syncAdapters";
import { isNativePlatform } from "../lib/platform";
import { canUseNativeAutoBackup } from "../services/nativeAutoBackup";
import { AutoBackupPanel } from "../components/AutoBackupPanel";
import { CloudSyncPanel } from "../components/CloudSyncPanel";
import { PageHeader, SurfaceCard } from "../components/ui";
import { importRecordTransferPackage, parseRecordTransferPackage } from "../services/recordTransferService";
import { formatUiError } from "../lib/uiError";

interface BackupPageProps {
  settings: AppSettings;
  autoBackupState: AutoBackupSettings;
  onRestored: () => Promise<void> | void;
}

type ImportStatus =
  | { state: "idle" }
  | { state: "choosing"; title: string; detail: string }
  | { state: "parsing"; title: string; detail: string }
  | { state: "restoring"; title: string; detail: string; summary: ImportSummary }
  | { state: "success"; title: string; detail: string; summary: ImportSummary }
  | { state: "cancelled"; title: string; detail: string }
  | { state: "error"; title: string; detail: string };

const formatImportSummary = (summary: ImportSummary) =>
  `导入 ${summary.records} 条日志，覆盖 ${summary.days} 天；资源 ${summary.assets} 个（图片 ${summary.images}、音频 ${summary.audio}、附件 ${summary.attachments}）。`;

const progressDetail = (progress: ImportProgress | ExportProgress) =>
  progress.total ? `${progress.message}（${progress.current ?? 0}/${progress.total}）` : progress.message;

const ImportStatusCard = ({ status }: { status: ImportStatus }) => {
  if (status.state === "idle") {
    return null;
  }

  const className = `import-status-card import-status-${status.state}`;
  const summary = "summary" in status ? status.summary : undefined;

  return (
    <section className={className} role="status" aria-live="polite">
      <div>
        <strong>{status.title}</strong>
        <p>{status.detail}</p>
      </div>
      {summary && (
        <dl>
          <div>
            <dt>日志</dt>
            <dd>{summary.records}</dd>
          </div>
          <div>
            <dt>天数</dt>
            <dd>{summary.days}</dd>
          </div>
          <div>
            <dt>回收站</dt>
            <dd>{summary.deletedRecords}</dd>
          </div>
          <div>
            <dt>资源</dt>
            <dd>{summary.assets}</dd>
          </div>
        </dl>
      )}
      {summary?.missingAssets ? (
        <p className="import-warning">有 {summary.missingAssets} 个资源文件未在备份包中找到，相关记录会保留资源缺失占位。</p>
      ) : null}
    </section>
  );
};

export const BackupPage = ({ settings, autoBackupState, onRestored }: BackupPageProps) => {
  const [message, setMessage] = useState("");
  const [importStatus, setImportStatus] = useState<ImportStatus>({ state: "idle" });
  const [busy, setBusy] = useState<ExportKind | "import" | "repository-import" | "record-transfer-parse" | "record-transfer-import" | null>(null);
  const [transfer, setTransfer] = useState<RecordTransferPackage>();
  const [selectedTransferRecordIds, setSelectedTransferRecordIds] = useState<string[]>([]);
  const transferInputRef = useRef<HTMLInputElement>(null);
  const transferAbortRef = useRef<AbortController>();
  const native = isNativePlatform();
  const repositoryAvailable = canUseNativeAutoBackup();

  useEffect(() => () => transferAbortRef.current?.abort(), []);

  const run = async (action: ExportKind | "import" | "repository-import", task: () => Promise<string | void>) => {
    setBusy(action);
    setMessage("");
    try {
      const result = await task();
      if (result) {
        setMessage(result);
      }
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
    } finally {
      setBusy(null);
    }
  };

  const exportFull = () =>
    run("full-backup", async () => {
      const result = await exportFullBackupFromStorage(storage, {
        onProgress: (progress) => setMessage(progressDetail(progress)),
      });
      return `${result} 这是可导入恢复的完整备份。`;
    });

  const importZip = () =>
    run("import", async () => {
      setImportStatus({ state: "idle" });
      const ok = window.confirm("导入完整备份会覆盖当前本地数据。建议先导出一份完整备份，再继续导入。");
      if (!ok) {
        setImportStatus({ state: "cancelled", title: "已取消导入", detail: "没有修改当前本地数据。" });
        return;
      }
      const adapter = native ? nativeBackupAdapter : manualZipSyncAdapter;
      setImportStatus({ state: "choosing", title: "选择备份文件", detail: "请在文件选择器中选择完整备份 zip。" });
      let activeSummary: ImportSummary | undefined;
      try {
        const summary = await importAndRestoreSnapshot({
          adapter,
          onRestored,
          onSummary: (summary) => {
            activeSummary = summary;
            setImportStatus({
              state: "restoring",
              title: "正在恢复数据",
              detail: "备份已通过校验，正在覆盖当前本地数据。",
              summary,
            });
          },
          onProgress: (progress) => {
            if (progress.stage === "choosing") {
              setImportStatus({ state: "choosing", title: "选择备份文件", detail: progressDetail(progress) });
              return;
            }
            if (progress.stage === "restoring" && activeSummary) {
              setImportStatus({
                state: "restoring",
                title: "正在恢复数据",
                detail: progressDetail(progress),
                summary: activeSummary,
              });
              return;
            }
            setImportStatus({
              state: "parsing",
              title: progress.stage === "reading" ? "正在读取备份" : "正在解析备份",
              detail: progressDetail(progress),
            });
          },
          onAutoBackupError: (detail) => setMessage(`导入已完成，但后台自动备份更新失败：${detail}`),
        });
        if (!summary) {
          setImportStatus({ state: "cancelled", title: "已取消导入", detail: "未选择备份文件，没有修改当前本地数据。" });
          return;
        }
        setImportStatus({
          state: "success",
          title: "导入成功",
          detail: `${formatImportSummary(summary)} 备份版本 v${summary.version}。自动备份会在后台更新。`,
          summary,
        });
      } catch (error) {
        const detail = formatUiError(error, "generic");
        setImportStatus({ state: "error", title: "导入失败", detail });
        throw error;
      }
    });

  const importRepository = () =>
    run("repository-import", async () => {
      setImportStatus({ state: "idle" });
      const ok = window.confirm("从自动备份文件夹恢复会覆盖当前本地数据。请确认已绑定旧仓库所在的父文件夹，或直接绑定 study-journal-backup 文件夹。");
      if (!ok) {
        setImportStatus({ state: "cancelled", title: "已取消恢复", detail: "没有修改当前本地数据。" });
        return;
      }
      let activeSummary: ImportSummary | undefined;
      setImportStatus({ state: "parsing", title: "检查自动备份仓库", detail: "正在校验 manifest、snapshot 和资源文件。" });
      try {
        const directory = await currentKnowledgeBackupDirectory();
        const restoreRepository = directory ? createNativeRepository(directory).restoreNativeRepositoryBackup : restoreNativeRepositoryBackup;
        const summary = await restoreRepository(storage, {
          onRestored,
          onProgress: (progress) => {
            if (progress.stage === "restoring" && activeSummary) {
              setImportStatus({
                state: "restoring",
                title: "正在恢复数据",
                detail: progressDetail(progress),
                summary: activeSummary,
              });
              return;
            }
            if (progress.stage === "assets" && activeSummary) {
              setImportStatus({
                state: "restoring",
                title: "正在恢复资源",
                detail: progressDetail(progress),
                summary: activeSummary,
              });
              return;
            }
            setImportStatus({
              state: "parsing",
              title: progress.stage === "indexing" ? "检查自动备份仓库" : "正在解析仓库快照",
              detail: progressDetail(progress),
            });
          },
        });
        activeSummary = summary;
        setImportStatus({
          state: "success",
          title: "仓库恢复成功",
          detail: `${formatImportSummary(summary)} 备份版本 v${summary.version}。`,
          summary,
        });
      } catch (error) {
        const detail = formatUiError(error, "generic");
        setImportStatus({ state: "error", title: "仓库恢复失败", detail });
        throw error;
      }
    });

  const chooseTransfer = async () => {
    if (!native) {
      transferInputRef.current?.click();
      return;
    }
    setBusy("record-transfer-parse");
    setMessage("");
    try {
      const file = await pickNativeZipFile({
        onProgress: (progress) => setMessage(progressDetail(progress)),
      });
      if (file) {
        await parseTransfer(file);
      }
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
    } finally {
      setBusy(null);
    }
  };

  const parseTransfer = async (file: File) => {
    const controller = new AbortController();
    transferAbortRef.current?.abort();
    transferAbortRef.current = controller;
    setBusy("record-transfer-parse");
    setMessage("");
    try {
      const parsed = await parseRecordTransferPackage(file, {
        onProgress: (progress) => setMessage(progressDetail(progress)),
        signal: controller.signal,
      });
      setTransfer(parsed);
      setSelectedTransferRecordIds(parsed.payload.records.map((record) => record.id));
      setMessage(`已找到 ${parsed.payload.records.length} 条日志和 ${parsed.payload.assets.length} 个资源，请确认要导入的内容。`);
    } catch (error) {
      setTransfer(undefined);
      setSelectedTransferRecordIds([]);
      setMessage(formatUiError(error, "generic"));
    } finally {
      if (transferAbortRef.current === controller) {
        transferAbortRef.current = undefined;
      }
      setBusy(null);
    }
  };

  const toggleTransferRecord = (recordId: string) => {
    setSelectedTransferRecordIds((current) =>
      current.includes(recordId) ? current.filter((id) => id !== recordId) : [...current, recordId],
    );
  };

  const importTransfer = async () => {
    if (!transfer) {
      return;
    }
    const controller = new AbortController();
    transferAbortRef.current = controller;
    setBusy("record-transfer-import");
    setMessage("");
    try {
      const summary = await importRecordTransferPackage(storage, transfer, selectedTransferRecordIds, {
        onProgress: (progress) => setMessage(progressDetail(progress)),
        signal: controller.signal,
      });
      await onRestored();
      setTransfer(undefined);
      setSelectedTransferRecordIds([]);
      setMessage(`已导入 ${summary.records} 条日志、${summary.assets} 个资源；导入日志默认未加入复习计划。`);
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
    } finally {
      if (transferAbortRef.current === controller) {
        transferAbortRef.current = undefined;
      }
      setBusy(null);
    }
  };

  const cancelTransfer = () => transferAbortRef.current?.abort();

  return (
    <main className="page backup-page">
      <PageHeader
        eyebrow="Backup"
        title="备份与恢复"
        subtitle="完整备份、导入恢复和自动备份都在这里管理。"
        density="compact"
      />

      <CloudSyncPanel onRestored={onRestored} />

      <section className="more-section backup-actions-section">
        <h2>完整备份</h2>
        <div className="more-grid backup-action-grid">
          <SurfaceCard className="more-action-card backup-action-card" variant="raised">
            <div>
              <Download size={20} />
              <h3>导出完整备份</h3>
              <p>生成可在 Web 和 Android 互相恢复的 zip，包含日志、图片、音频、附件、OCR 和设置。</p>
            </div>
            <button type="button" className="primary-button" onClick={exportFull} disabled={busy !== null}>
              <Download size={18} />
              {native ? "导出并分享" : "导出 zip"}
            </button>
          </SurfaceCard>

          <SurfaceCard className="more-action-card backup-action-card" variant="raised">
            <div>
              <Upload size={20} />
              <h3>导入恢复</h3>
              <p>只接受完整备份 zip。导入会覆盖当前本地数据，512MB 以上建议优先用自动备份文件夹恢复。</p>
            </div>
            <button type="button" className="secondary-button" onClick={importZip} disabled={busy !== null}>
              <Upload size={18} />
              {busy === "import" ? "导入中..." : "从 zip 导入"}
            </button>
          </SurfaceCard>

          {repositoryAvailable && (
            <SurfaceCard className="more-action-card backup-action-card" variant="raised">
              <div>
                <DatabaseBackup size={20} />
                <h3>自动备份文件夹恢复</h3>
                <p>从已绑定的增量仓库拉取恢复。Windows 请先绑定包含 study-journal-backup 的文件夹；恢复前会校验快照和资源完整性。</p>
              </div>
              <button type="button" className="secondary-button" onClick={importRepository} disabled={busy !== null}>
                <DatabaseBackup size={18} />
                {busy === "repository-import" ? "恢复中..." : "从文件夹恢复"}
              </button>
            </SurfaceCard>
          )}
        </div>
        <ImportStatusCard status={importStatus} />
      </section>

      <section className="more-section backup-actions-section">
        <h2>日志互通</h2>
        <div className="more-grid backup-action-grid">
          <SurfaceCard className="more-action-card backup-action-card" variant="raised">
            <div>
              <FileArchive size={20} />
              <h3>导入日志互通包</h3>
              <p>追加单条或多条日志及其图片、录音、附件和 OCR，不覆盖当前本地数据。</p>
            </div>
            <button type="button" className="secondary-button" onClick={() => void chooseTransfer()} disabled={busy !== null}>
              <Upload size={18} />
              {busy === "record-transfer-parse" ? "解析中..." : "选择互通 zip"}
            </button>
            <input
              ref={transferInputRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  void parseTransfer(file);
                }
              }}
            />
          </SurfaceCard>
        </div>
        {(busy === "record-transfer-parse" || busy === "record-transfer-import") && (
          <button type="button" className="subtle-button" onClick={cancelTransfer}>
            取消日志导入
          </button>
        )}
        {transfer && (
          <section className="import-status-card import-status-parsing" aria-live="polite">
            <div>
              <strong>选择要导入的日志</strong>
              <p>已选 {selectedTransferRecordIds.length}/{transfer.payload.records.length} 条。重名日志会创建“导入副本”，不会覆盖当前内容。</p>
            </div>
            <div className="record-list">
              {transfer.payload.records.map((record) => {
                const selected = selectedTransferRecordIds.includes(record.id);
                return (
                  <button
                    type="button"
                    key={record.id}
                    className={`selectable-record-row ${selected ? "selected" : ""}`}
                    onClick={() => toggleTransferRecord(record.id)}
                    aria-pressed={selected}
                  >
                    {selected ? <CheckSquare size={18} /> : <Square size={18} />}
                    <span>{record.date} / {record.subject} / {record.title}</span>
                  </button>
                );
              })}
            </div>
            <div className="record-action-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setSelectedTransferRecordIds((current) => current.length === transfer.payload.records.length ? [] : transfer.payload.records.map((record) => record.id))}
                disabled={busy !== null}
              >
                {selectedTransferRecordIds.length === transfer.payload.records.length ? "取消全选" : "全选"}
              </button>
              <button type="button" className="primary-button" onClick={() => void importTransfer()} disabled={busy !== null || selectedTransferRecordIds.length === 0}>
                <Upload size={18} />
                {busy === "record-transfer-import" ? "导入中..." : `导入 ${selectedTransferRecordIds.length} 条`}
              </button>
            </div>
          </section>
        )}
      </section>

      <AutoBackupPanel autoBackupState={autoBackupState} onChanged={onRestored} />

      {busy && <p className="status-message">正在处理，请稍等...</p>}
      {message && <p className="status-message">{message}</p>}
    </main>
  );
};
