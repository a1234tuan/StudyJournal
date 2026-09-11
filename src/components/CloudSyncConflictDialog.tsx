import { AlertTriangle } from "lucide-react";
import { useState } from "react";

import { MotionPresence } from "./MotionPresence";
import { formatUiError } from "../lib/uiError";
import { getCurrentCloudUser, resolveCloudSyncConflict, synchronizeCloudChanges } from "../services/cloudSyncService";
import { cloudSyncStore, useCloudSyncStore } from "../services/cloudSyncStore";

interface CloudSyncConflictDialogProps {
  /** Called after a sync that restored/replaced local data, so the caller can refresh its view. */
  onRestored: () => Promise<void> | void;
}

const errorMessage = (error: unknown) => formatUiError(error, "cloud-sync");

/**
 * Global modal for resolving cloud sync conflicts. Mounted once at the app shell root so it can
 * interrupt the user regardless of which tab/page triggered the sync (home button, sidebar button,
 * or the sync panel under 更多 → 云同步).
 */
export const CloudSyncConflictDialog = ({ onRestored }: CloudSyncConflictDialogProps) => {
  const { busy, conflict, message, readBudget, readBudgetChoice, writeBudget, writeBudgetChoice } = useCloudSyncStore();
  const [approvedBudgets, setApprovedBudgets] = useState({ read: false, write: false });

  if (!conflict) {
    return <MotionPresence present={false} variant="modal" className="cloud-sync-conflict-backdrop" role="presentation">{null}</MotionPresence>;
  }

  const resolve = async (
    choice: "local" | "cloud",
    approvals = { read: false, write: false },
  ) => {
    const user = getCurrentCloudUser();
    if (!user) return;
    cloudSyncStore.setBusy("resolve");
    const token = cloudSyncStore.currentToken();
    const isCurrentOperation = () =>
      cloudSyncStore.isCurrent(token) && getCurrentCloudUser()?.uid === user.uid;
    cloudSyncStore.setMessage(choice === "local" ? "正在以本机数据更新云端。" : "正在保存本机恢复点并恢复云端数据。");
    try {
      const result = await resolveCloudSyncConflict(user, choice, {
        allowExpensiveRead: approvals.read,
        allowExpensiveWrite: approvals.write,
        onProgress: (event) => {
          if (isCurrentOperation()) cloudSyncStore.setMessage(event.message);
        },
      });
      // A watchdog timeout or background/foreground transition may have already cleared this
      // operation (e.g. the OS suspended the request mid-flight) — don't resurrect stale state,
      // and don't keep going with a second network round-trip the user no longer expects.
      if (!isCurrentOperation()) return;
      if (result.kind === "conflict") {
        cloudSyncStore.setConflict(result.conflict);
        cloudSyncStore.setMessage("云端状态已变化，请重新选择同步策略。");
        return;
      }
      if (result.kind === "read-budget") {
        setApprovedBudgets(approvals);
        cloudSyncStore.setReadBudget(result.estimate);
        cloudSyncStore.setReadBudgetChoice(result.choice);
        cloudSyncStore.setMessage(result.message);
        return;
      }
      if (result.kind === "write-budget") {
        setApprovedBudgets(approvals);
        cloudSyncStore.setWriteBudget(result.estimate);
        cloudSyncStore.setWriteBudgetChoice(result.choice);
        cloudSyncStore.setMessage(result.message);
        return;
      }
      if (result.kind === "uncertain") {
        cloudSyncStore.setConflict(undefined);
        cloudSyncStore.setOutcome("uncertain", result.message);
        return;
      }
      cloudSyncStore.setConflict(undefined);
      setApprovedBudgets({ read: false, write: false });
      if (choice === "cloud") {
        await onRestored();
        cloudSyncStore.setMessage("正在上传本机剩余更改。");
        const finalResult = await synchronizeCloudChanges(user, {
          onProgress: (event) => {
            if (isCurrentOperation()) cloudSyncStore.setMessage(event.message);
          },
        });
        if (!isCurrentOperation()) return;
        if (finalResult.kind === "synced") {
          const uploaded = result.uploaded + finalResult.uploaded;
          const downloaded = result.downloaded + finalResult.downloaded;
          const noChange = uploaded === 0 && downloaded === 0;
          cloudSyncStore.setOutcome(
            noChange ? "no-change" : "success",
            noChange ? "同步完成：本机和云端均无新变化。" : `同步完成：上传 ${uploaded} 项，下载 ${downloaded} 项。`,
          );
        } else if (finalResult.kind === "uncertain") {
          cloudSyncStore.setOutcome("uncertain", finalResult.message);
        } else if (finalResult.kind === "read-budget") {
          cloudSyncStore.setConflict({ reason: "concurrent-changes", localChanges: 0, remoteChanges: 0, cloudRevision: 0 });
          cloudSyncStore.setReadBudget(finalResult.estimate);
          cloudSyncStore.setReadBudgetChoice(finalResult.choice);
          cloudSyncStore.setMessage(finalResult.message);
        } else if (finalResult.kind === "write-budget") {
          cloudSyncStore.setConflict({ reason: "concurrent-changes", localChanges: 0, remoteChanges: 0, cloudRevision: 0 });
          cloudSyncStore.setWriteBudget(finalResult.estimate);
          cloudSyncStore.setWriteBudgetChoice(finalResult.choice);
          cloudSyncStore.setMessage(finalResult.message);
        } else {
          cloudSyncStore.setConflict(finalResult.conflict);
          cloudSyncStore.setMessage("已恢复云端数据，但上传本机数据时再次遇到冲突，请重新选择策略。");
        }
      } else {
        const noChange = result.uploaded === 0 && result.downloaded === 0;
        cloudSyncStore.setOutcome(
          noChange ? "no-change" : "success",
          noChange ? "同步完成：本机和云端均无新变化。" : `同步完成：上传 ${result.uploaded} 项，下载 ${result.downloaded} 项。`,
        );
      }
    } catch (error) {
      if (!isCurrentOperation()) return;
      // If the conflict dialog is still open (error happened before we cleared it), show the
      // reason inline like before. Otherwise the dialog has already closed, so it needs the toast.
      if (cloudSyncStore.getSnapshot().conflict) {
        cloudSyncStore.setMessage(errorMessage(error));
      } else {
        cloudSyncStore.setOutcome("error", errorMessage(error));
      }
    } finally {
      cloudSyncStore.finishBusy(token);
    }
  };

  const continueWriteBudget = async () => {
    const user = getCurrentCloudUser();
    if (!user) return;
    if (writeBudgetChoice === "sync") {
      cloudSyncStore.setBusy("sync");
      const token = cloudSyncStore.currentToken();
      try {
        const result = await synchronizeCloudChanges(user, {
          allowExpensiveWrite: true,
          onProgress: (event) => {
            if (cloudSyncStore.isCurrent(token)) cloudSyncStore.setMessage(event.message);
          },
        });
        if (!cloudSyncStore.isCurrent(token)) return;
        if (result.kind === "synced") {
          cloudSyncStore.setConflict(undefined);
          if (result.restored) await onRestored();
          const noChange = result.uploaded === 0 && result.downloaded === 0;
          cloudSyncStore.setOutcome(
            noChange ? "no-change" : "success",
            noChange ? "同步完成：本机和云端均无新变化。" : `同步完成：上传 ${result.uploaded} 项，下载 ${result.downloaded} 项。`,
          );
        } else if (result.kind === "uncertain") {
          cloudSyncStore.setConflict(undefined);
          cloudSyncStore.setOutcome("uncertain", result.message);
        } else if (result.kind === "conflict") {
          cloudSyncStore.setConflict(result.conflict);
          cloudSyncStore.setMessage("云端状态已变化，请重新选择同步策略。");
        } else if (result.kind === "read-budget") {
          cloudSyncStore.setReadBudget(result.estimate);
          cloudSyncStore.setReadBudgetChoice(result.choice);
          cloudSyncStore.setMessage(result.message);
        } else {
          cloudSyncStore.setWriteBudget(result.estimate);
          cloudSyncStore.setWriteBudgetChoice(result.choice);
          cloudSyncStore.setMessage(result.message);
        }
      } catch (error) {
        cloudSyncStore.setOutcome("error", errorMessage(error));
      } finally {
        cloudSyncStore.finishBusy(token);
      }
      return;
    }
    await resolve(writeBudgetChoice ?? "local", { ...approvedBudgets, write: true });
  };

  const cancel = () => {
    cloudSyncStore.setConflict(undefined);
    cloudSyncStore.setReadBudget(undefined);
    cloudSyncStore.setReadBudgetChoice(undefined);
    cloudSyncStore.setWriteBudget(undefined);
    cloudSyncStore.setWriteBudgetChoice(undefined);
    setApprovedBudgets({ read: false, write: false });
    cloudSyncStore.setOutcome("no-change", "已取消，本机和云端数据均未修改。");
  };

  return (
    <MotionPresence present variant="modal" className="cloud-sync-conflict-backdrop" role="presentation">
      <section
        className="cloud-sync-conflict-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cloud-sync-conflict-title"
      >
        <p className="eyebrow">
          <AlertTriangle size={16} />
          云同步冲突
        </p>
        <h2 id="cloud-sync-conflict-title">
          {writeBudget
            ? "需要确认高写入量同步"
            : readBudget
            ? "需要确认高读取量恢复"
            : conflict.reason === "legacy-snapshot"
            ? "检测到旧版完整云端备份"
            : conflict.reason === "local-changed-during-sync"
              ? "同步期间本机发生了新编辑"
              : "检测到双端并发编辑"}
        </h2>
        <p>
          {writeBudget
            ? "为避免意外消耗 Firebase 写入和 Storage 额度，同步已暂停。你可以取消，或确认继续。"
            : readBudget
            ? "为避免意外消耗 Firebase 读取额度，恢复操作已暂停。你可以取消，或确认继续。"
            : conflict.reason === "local-changed-during-sync"
            ? "本次同步未覆盖本机内容，请重新检查更改后再同步。"
            : `本机待同步实体/事件 ${conflict.localChanges} 项，云端待拉取实体/事件 ${conflict.remoteChanges} 项。选择前会自动保留恢复点。`}
        </p>
        {conflict.conflicts?.length ? (
          <ul className="cloud-sync-conflict-fields">
            {conflict.conflicts.map((item) => (
              <li key={item.key}>
                {item.key}{item.fields?.length ? `：${item.fields.join("、")}` : ""}
                {item.reason === "content" ? "（内容冲突）" : item.reason === "field" ? "（字段冲突）" : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {message ? <p className="cloud-sync-conflict-status" role="status">{message}</p> : null}
        {readBudget ? (
          <div className="cloud-sync-read-budget" role="status">
            <strong>高成本恢复确认</strong>
            <p>
              {Number.isFinite(readBudget.estimatedReads)
                ? `预计 Firestore 读取 ${readBudget.estimatedReads.toLocaleString()} 次：实体 ${readBudget.entityReads.toLocaleString()}，复习事件 ${readBudget.reviewEventReads.toLocaleString()}，定点 ${readBudget.targetedReads.toLocaleString()}，固定开销 ${readBudget.overheadReads}。`
                : "无法可靠估算读取量，本次恢复按高风险处理。"}
            </p>
            <p>
              {readBudget.storageKnown
                ? `预计下载 Storage ${readBudget.storageObjectCount.toLocaleString()} 个对象 / ${(readBudget.storageBytes / (1024 * 1024)).toFixed(1)} MiB。`
                : "无法可靠估算 Storage 对象数量或下载大小，本次恢复按高风险处理。"}
            </p>
            {readBudget.estimatedReads >= 50_000 || !Number.isFinite(readBudget.estimatedReads) || !readBudget.storageKnown || readBudget.storageObjectCount >= 500 || readBudget.storageBytes >= 100 * 1024 * 1024 ? (
              <p>该操作可能超过 Firebase 免费额度或产生额外费用。</p>
            ) : null}
          </div>
        ) : null}
        {writeBudget ? (
          <div className="cloud-sync-read-budget" role="status">
            <strong>高成本写入确认</strong>
            <p>
              预计 Firestore 写入 {writeBudget.estimatedWrites.toLocaleString()} 次：实体 {writeBudget.entityWrites.toLocaleString()}，复习事件 {writeBudget.reviewEventWrites.toLocaleString()}，协议开销约 {writeBudget.overheadWrites}。
            </p>
            <p>
              可能上传 Storage {writeBudget.storageObjectCount.toLocaleString()} 个对象 / {(writeBudget.storageBytes / (1024 * 1024)).toFixed(1)} MiB；实际值可能因内容哈希去重更低。
            </p>
          </div>
        ) : null}
        <div className="cloud-sync-conflict-actions">
          {!readBudget && !writeBudget ? (
            <>
              <button type="button" className="primary-button" onClick={() => { setApprovedBudgets({ read: false, write: false }); void resolve("local"); }} disabled={busy !== null}>
                以本机为准
              </button>
              <button type="button" className="secondary-button" onClick={() => { setApprovedBudgets({ read: false, write: false }); void resolve("cloud"); }} disabled={busy !== null}>
                以云端为准
              </button>
            </>
          ) : null}
          {readBudget ? (
            <button type="button" className="primary-button" onClick={() => void resolve(readBudgetChoice ?? "cloud", { ...approvedBudgets, read: true })} disabled={busy !== null}>
              {readBudgetChoice === "local" ? "继续高成本以本机为准" : "继续高成本以云端为准"}
            </button>
          ) : null}
          {writeBudget ? (
            <button type="button" className="primary-button" onClick={() => void continueWriteBudget()} disabled={busy !== null}>
              继续高成本同步
            </button>
          ) : null}
          <button type="button" className="secondary-button" onClick={cancel} disabled={busy !== null}>
            取消
          </button>
        </div>
      </section>
    </MotionPresence>
  );
};
