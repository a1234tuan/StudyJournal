import { RefreshCw } from "lucide-react";

import { completeCloudSync } from "../services/cloudSyncCoordinator";
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
  const { busy, outcome } = useCloudSyncStore();
  const spinning = busy === "sync" || busy === "resolve";

  const handleClick = async () => {
    const user = getCurrentCloudUser();
    if (!user) {
      onSignedOut();
      return;
    }
    if (cloudSyncStore.getSnapshot().busy !== null || cloudSyncStore.getSnapshot().conflict) return;
    const reconciling = outcome?.status === "uncertain";
    cloudSyncStore.setBusy("sync");
    const token = cloudSyncStore.currentToken();
    const isCurrentOperation = () =>
      cloudSyncStore.isCurrent(token) && getCurrentCloudUser()?.uid === user.uid;
    cloudSyncStore.setConflict(undefined);
    cloudSyncStore.setMessage(reconciling ? "正在核对上一次同步结果。" : "正在检查本机和云端的更改。");
    try {
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
        cloudSyncStore.setMessage("检测到普通日志存在同步冲突，请选择保留哪一侧。知识库本次尚未同步。");
      } else if (result.kind === "read-budget") {
        cloudSyncStore.setConflict({
          reason: "concurrent-changes",
          localChanges: 0,
          remoteChanges: 0,
          cloudRevision: 0,
        });
        cloudSyncStore.setReadBudget(result.estimate);
        cloudSyncStore.setReadBudgetChoice(result.choice);
        cloudSyncStore.setMessage(result.message + " 知识库本次尚未同步。");
      } else if (result.kind === "write-budget") {
        cloudSyncStore.setConflict({
          reason: "concurrent-changes",
          localChanges: 0,
          remoteChanges: 0,
          cloudRevision: 0,
        });
        cloudSyncStore.setWriteBudget(result.estimate);
        cloudSyncStore.setWriteBudgetChoice(result.choice);
        cloudSyncStore.setMessage(result.message + " 知识库本次尚未同步。");
      } else if (result.kind === "uncertain") {
        cloudSyncStore.setOutcome("uncertain", result.message + " 知识库本次尚未同步。");
      } else {
        if (result.restored) await onRestored();
        const outcome = await completeCloudSync(result, {
          isCurrent: isCurrentOperation,
          onProgress: message => { if (isCurrentOperation()) cloudSyncStore.setMessage(message); },
        });
        if (outcome && isCurrentOperation()) cloudSyncStore.setOutcome(outcome.status, outcome.message);
      }
    } catch (error) {
      if (isCurrentOperation()) cloudSyncStore.setOutcome("error", "普通日志：" + errorMessage(error) + " 知识库本次尚未同步。");
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
