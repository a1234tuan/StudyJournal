import { CheckCircle2, FolderOpen, RefreshCw, ShieldCheck, ToggleLeft, ToggleRight } from "lucide-react";
import { useState } from "react";

import type { AutoBackupSettings } from "../types";
import { formatBytes } from "../lib/format";
import {
  bindAutoBackupFolder,
  flushAutoBackupNow,
  setAutoBackupEnabled,
} from "../services/autoBackupService";
import { isDesktopPlatform } from "../lib/platform";
import { formatUiError } from "../lib/uiError";

interface AutoBackupPanelProps {
  autoBackupState: AutoBackupSettings;
  onChanged: () => Promise<void> | void;
}

const formatDateTime = (value?: string): string =>
  value ? new Date(value).toLocaleString() : "尚未备份";

const formatBackupFileName = (state: AutoBackupSettings): string => {
  if (!state.lastBackupAt) {
    return "-";
  }
  return state.lastBackupFileName ?? "study-journal-latest.zip";
};

const formatBackupKind = (state: AutoBackupSettings): string => {
  return state.backupFormat === "folder-repository-v1" ? "增量文件夹备份" : "latest zip";
};

const formatBackupSize = (state: AutoBackupSettings): string => {
  const size = state.backupFormat === "folder-repository-v1"
    ? state.lastBackupRepositorySize ?? state.lastBackupSize
    : state.lastBackupSize;
  return size ? formatBytes(size) : "-";
};

const formatBytesValue = (value?: number): string =>
  value ? formatBytes(value) : "-";

const backupSuccessMessage = (state: AutoBackupSettings, message: string): string => {
  if (state.lastError) {
    throw new Error(state.lastError);
  }
  return message;
};

const backupActionMessage = (state: AutoBackupSettings): string => {
  const repository = state.backupFormat === "folder-repository-v1";
  return repository
    ? "已立即同步到增量备份仓库。"
    : "已立即同步到 study-journal-latest.zip。";
};

export const AutoBackupPanel = ({ autoBackupState, onChanged }: AutoBackupPanelProps) => {
  const desktop = isDesktopPlatform();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const run = async (task: () => Promise<string>) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await task();
      setMessage(result);
      await onChanged();
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="auto-backup-panel">
      <header>
        <div>
          <p className="eyebrow">Auto Backup</p>
          <h2>自动备份</h2>
        </div>
        <ShieldCheck size={22} />
      </header>
      <p>完整备份包含设备上的普通日志，以及当前身份拥有的全部本机知识库。普通日志不按账号分区；其他账号的知识库不纳入。首次启用请确认范围并绑定备份文件夹。</p>
      <div className="auto-backup-status">
        <div>
          <span>状态</span>
          <strong>{autoBackupState.enabled ? "已开启" : "未开启"}</strong>
        </div>
        <div>
          <span>备份位置</span>
          <strong>{autoBackupState.folderName ?? "未绑定文件夹"}</strong>
        </div>
        <div>
          <span>最近备份</span>
          <strong>{formatDateTime(autoBackupState.lastBackupAt)}</strong>
        </div>
        <div>
          <span>备份文件</span>
          <strong>{formatBackupFileName(autoBackupState)}</strong>
        </div>
        <div>
          <span>备份格式</span>
          <strong>{formatBackupKind(autoBackupState)}</strong>
        </div>
        <div>
          <span>{autoBackupState.backupFormat === "folder-repository-v1" ? "仓库总大小" : "备份大小"}</span>
          <strong>{formatBackupSize(autoBackupState)}</strong>
        </div>
        {autoBackupState.backupFormat === "folder-repository-v1" && (
          <>
            <div>
              <span>本次写入</span>
              <strong>{formatBytesValue(autoBackupState.lastBackupBytesWritten)}</strong>
            </div>
            <div>
              <span>资源数量</span>
              <strong>{autoBackupState.lastBackupAssetCount ?? "-"}</strong>
            </div>
            <div>
              <span>最新快照</span>
              <strong>{autoBackupState.lastBackupSnapshotId ?? "-"}</strong>
            </div>
          </>
        )}
      </div>
      <div className="card-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await bindAutoBackupFolder();
              if (desktop) {
                await setAutoBackupEnabled(true);
                const next = await flushAutoBackupNow("desktop-bind");
                return backupSuccessMessage(next, "已绑定备份文件夹并完成首次增量仓库备份。");
              }
              return `已绑定备份文件夹。若要恢复旧仓库，请使用”从自动备份文件夹恢复”；若要推送当前本地数据，请先开启自动备份再点击”立即同步”。`;
            })
          }
        >
          <FolderOpen size={18} />
          绑定备份文件夹
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await setAutoBackupEnabled(!autoBackupState.enabled);
              return autoBackupState.enabled ? "已关闭自动备份。" : "已开启自动备份。";
            })
          }
        >
          {autoBackupState.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
          {autoBackupState.enabled ? "关闭自动备份" : "开启自动备份"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !autoBackupState.enabled}
          onClick={() =>
            void run(async () => {
              const next = await flushAutoBackupNow("manual");
              return backupSuccessMessage(next, backupActionMessage(next));
            })
          }
        >
          <RefreshCw size={18} />
          立即同步
        </button>
      </div>
      {autoBackupState.lastError && <p className="status-message">{autoBackupState.lastError}</p>}
      {autoBackupState.lastBackupWarning && <p className="status-message">{autoBackupState.lastBackupWarning}</p>}
      {message && (
        <p className="status-message">
          <CheckCircle2 size={15} />
          {message}
        </p>
      )}
      <details className="auto-backup-help">
        <summary>备份说明</summary>
        <p className="helper-text">
          建议选择网盘同步目录或手机公共文档目录。断网不影响本地记录，但卸载 App、清理应用数据或浏览器站点数据会删除本地库；Web 端自动备份会覆盖同一份 latest zip。
          {desktop
            ? "桌面端写入当前身份专属的增量备份子目录，只同步新增或缺失资源，并保留最近 5 个快照。绑定不立即备份；开启后在打开应用、内容静默 10 分钟以及关闭窗口前同步。"
            : `Android 端会写入当前身份专属的增量备份子目录，只同步新增或缺失资源，并保留最近 5 个快照。自动备份会在打开 App 时同步一次；编辑过程中需要立刻备份时，请点击"立即同步"。绑定只授予文件夹权限；从旧仓库拉取请使用"从自动备份文件夹恢复"。`}
        </p>
      </details>
    </section>
  );
};
