import { RefreshCw } from "lucide-react";

import { formatUiError } from "../lib/uiError";
import { getCurrentCloudUser, synchronizeCloudChanges } from "../services/cloudSyncService";
import { cloudSyncStore, useCloudSyncStore } from "../services/cloudSyncStore";

interface CloudSyncButtonProps {
  /** Called when the button is pressed while signed out — should route the user to cloud sync setup. */
  onSignedOut: () => void;
  /** Called after a sync that restored/replaced local data, so the caller can refresh its view. */
  onRestored: () => Promise<void> | void;
  className?: string;
}

const errorMessage = (error: unknown) => formatUiError(error, "cloud-sync");

export const CloudSyncButton = ({ onSignedOut, onRestored, className = "" }: CloudSyncButtonProps) => {
  const { busy, conflict, outcome } = useCloudSyncStore();
  const spinning = busy === "sync" || busy === "resolve";

  const handleClick = async () => {
    const user = getCurrentCloudUser();
    if (!user) {
      onSignedOut();
      return;
    }
    if (busy !== null || conflict) return;
    const reconciling = outcome?.status === "uncertain";
    cloudSyncStore.setBusy("sync");
    const token = cloudSyncStore.currentToken();
    const isCurrentOperation = () =>
      cloudSyncStore.isCurrent(token) && getCurrentCloudUser()?.uid === user.uid;
    cloudSyncStore.setConflict(undefined);
    cloudSyncStore.setMessage(reconciling ? "正在核对上一次同步结果。" : "正在检查本机和云端的更改。");
    let knowledgeSummary = "";
    try {
      const { synchronizeBoundKnowledge } = await import("../features/knowledgeLibrary/runtime");
      knowledgeSummary = await synchronizeBoundKnowledge();
      if (!isCurrentOperation()) return;
      const result = await synchronizeCloudChanges(user, {
        onProgress: (event) => {
          if (isCurrentOperation()) cloudSyncStore.setMessage(event.message);
        },
      });
      // The watchdog or a background/foreground transition may have already cleared this
      // operation (e.g. the OS suspended the request mid-flight) — don't resurrect stale state.
      if (!isCurrentOperation()) return;
      if (result.kind === "conflict") {
        cloudSyncStore.setConflict(result.conflict);
        cloudSyncStore.setMessage("检测到本机和云端都存在未同步的数据，请选择保留哪一侧。");
      } else if (result.kind === "read-budget") {
        cloudSyncStore.setConflict({
          reason: "concurrent-changes",
          localChanges: 0,
          remoteChanges: 0,
          cloudRevision: 0,
        });
        cloudSyncStore.setReadBudget(result.estimate);
        cloudSyncStore.setReadBudgetChoice(result.choice);
        cloudSyncStore.setMessage(result.message);
      } else if (result.kind === "write-budget") {
        cloudSyncStore.setConflict({
          reason: "concurrent-changes",
          localChanges: 0,
          remoteChanges: 0,
          cloudRevision: 0,
        });
        cloudSyncStore.setWriteBudget(result.estimate);
        cloudSyncStore.setWriteBudgetChoice(result.choice);
        cloudSyncStore.setMessage(result.message);
      } else if (result.kind === "uncertain") {
        cloudSyncStore.setOutcome("uncertain", result.message);
      } else {
        const noChange = result.uploaded === 0 && result.downloaded === 0;
        if (result.restored) await onRestored();
        if (!isCurrentOperation()) return;
        cloudSyncStore.setOutcome(
          noChange ? "no-change" : "success",
          (noChange ? "普通日志：本机和云端均无新变化。" : `普通日志：上传 ${result.uploaded} 项，下载 ${result.downloaded} 项。`) + " " + knowledgeSummary,
        );
      }
    } catch (error) {
      if (isCurrentOperation()) cloudSyncStore.setOutcome("error", "普通日志：" + errorMessage(error) + " " + knowledgeSummary);
    } finally {
      cloudSyncStore.finishBusy(token);
    }
  };

  return (
    <button
      type="button"
      className={`icon-button cloud-sync-button${spinning ? " spinning" : ""} ${className}`.trim()}
      onClick={() => void handleClick()}
      disabled={busy !== null}
      title="云同步"
      aria-label="云同步"
    >
      <RefreshCw size={18} />
    </button>
  );
};
