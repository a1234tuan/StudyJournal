import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../features/knowledgeLibrary/autoBackup", () => ({ authorizeKnowledgeBackup: vi.fn().mockResolvedValue(undefined) }));

import type { AutoBackupSettings } from "../types";
import { bindAutoBackupFolder, flushAutoBackupNow } from "../services/autoBackupService";
import { AutoBackupPanel } from "./AutoBackupPanel";

vi.mock("../services/autoBackupService", () => ({
  bindAutoBackupFolder: vi.fn(),
  flushAutoBackupNow: vi.fn(),
  setAutoBackupEnabled: vi.fn(),
}));

const state = (
  lastError?: string,
  patch: Partial<AutoBackupSettings> = {},
): AutoBackupSettings => ({
  enabled: true,
  folderName: "backup",
  debounceMs: 600_000,
  lastError,
  ...patch,
});

describe("AutoBackupPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds a folder without immediately syncing current local data", async () => {
    vi.mocked(bindAutoBackupFolder).mockResolvedValueOnce(state(undefined, { enabled: false, folderName: "old-backup" }));

    render(<AutoBackupPanel autoBackupState={state(undefined, { enabled: false })} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /绑定备份文件夹/ }));

    await waitFor(() => {
      expect(screen.getByText(/已绑定备份文件夹/)).toBeInTheDocument();
    });
    expect(bindAutoBackupFolder).toHaveBeenCalledTimes(1);
    expect(flushAutoBackupNow).not.toHaveBeenCalled();
    expect(screen.queryByText(/已绑定备份文件夹，并写入/)).not.toBeInTheDocument();
  });

  it("shows the sync error instead of a success message when flush reports a backup error", async () => {
    vi.mocked(flushAutoBackupNow).mockResolvedValueOnce(state("自动备份写入结果为空。"));

    render(<AutoBackupPanel autoBackupState={state()} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /立即同步/ }));

    await waitFor(() => {
      expect(screen.getByText(/操作没有完成，请稍后重试。.*诊断编号/)).toBeInTheDocument();
    });
    expect(screen.queryByText("自动备份写入结果为空。")).not.toBeInTheDocument();
    expect(screen.queryByText("已立即同步到增量备份仓库。")).not.toBeInTheDocument();
  });

  it("shows the verified backup file name from the latest successful sync", () => {
    render(
      <AutoBackupPanel
        autoBackupState={state(undefined, {
          lastBackupAt: "2026-06-21T01:00:00.000Z",
          lastBackupSize: 1234,
          lastBackupFileName: "study-journal-latest (1).zip",
          lastBackupWarning: "请在备份文件夹中查找：study-journal-latest (1).zip",
        })}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("study-journal-latest (1).zip")).toBeInTheDocument();
    expect(screen.getByText("请在备份文件夹中查找：study-journal-latest (1).zip")).toBeInTheDocument();
  });

  it("shows repository backup fields after a successful Android incremental backup", () => {
    render(
      <AutoBackupPanel
        autoBackupState={state(undefined, {
          backupFormat: "folder-repository-v1",
          lastBackupAt: "2026-06-21T01:00:00.000Z",
          lastBackupSize: 9_000,
          lastBackupRepositorySize: 12_345,
          lastBackupBytesWritten: 456,
          lastBackupAssetCount: 7,
          lastBackupSnapshotId: "20260621T010000000Z",
          lastBackupFileName: "study-journal-backup",
        })}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("增量文件夹备份")).toBeInTheDocument();
    expect(screen.getByText("study-journal-backup")).toBeInTheDocument();
    expect(screen.getByText("资源数量")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("20260621T010000000Z")).toBeInTheDocument();
    expect(screen.getByText(/打开 App 时同步一次/)).toBeInTheDocument();
    expect(screen.getByText(/编辑过程中需要立刻备份/)).toBeInTheDocument();
  });
});
