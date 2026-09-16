import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordBlock, RecordDraft } from "../types";

/**
 * The daily-plan workspace decides between "未完成" and "未保存（上次输入已保留）"
 * by looking at `app.recordDrafts`. Draft writes are debounced and must not pay
 * for a full `refresh()`, so `useAppData` maintains that list in place - if it
 * silently stops doing so, a plan the user just typed into reads as untouched
 * and the regression is invisible outside a browser run.
 */

const mocks = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  listEntries: vi.fn().mockResolvedValue([]),
  listBlocks: vi.fn().mockResolvedValue([]),
  listTemplates: vi.fn().mockResolvedValue([]),
  getSettings: vi.fn().mockResolvedValue({ subjects: [] }),
  listAssets: vi.fn().mockResolvedValue([]),
  listDeletedBlocks: vi.fn().mockResolvedValue([]),
  listDailyPlans: vi.fn().mockResolvedValue([]),
  listDeletedDailyPlans: vi.fn().mockResolvedValue([]),
  listRecordDrafts: vi.fn().mockResolvedValue([]),
  listRecordReviews: vi.fn().mockResolvedValue([]),
  listDueRecordReviews: vi.fn().mockResolvedValue([]),
  listRecordReviewLogs: vi.fn().mockResolvedValue([]),
  getRecordReviewStats: vi.fn().mockResolvedValue({}),
  getAutoBackupState: vi.fn().mockResolvedValue({}),
  purgeExpiredDeletedBlocks: vi.fn().mockResolvedValue(0),
  saveRecordDraft: vi.fn(),
  deleteRecordDraft: vi.fn().mockResolvedValue(undefined),
  getRecordDraft: vi.fn().mockResolvedValue(undefined),
  markAutoBackupDirty: vi.fn().mockResolvedValue(undefined),
  getReviewCoachFormalSnapshot: vi.fn().mockResolvedValue({
    decisionBlocks: [],
    decisionBlockArchives: [],
    decisionBlockFeedback: [],
    feedbackInterpretations: [],
    analysisQueueItems: [],
    analysisBatches: [],
    sessionBlueprints: [],
    adaptiveReviewTasks: [],
    adaptiveQuizTurns: [],
    taskOutcomeEvents: [],
    delayedVerifications: [],
    aiRoleConfigs: [],
    legacyLearningEvidence: [],
    legacyKnowledgePoints: [],
    legacyRecordKnowledgePointLinks: [],
    legacyKnowledgeRelations: [],
  }),
  listFeedbackInterpretations: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/storageAdapter", () => ({
  storage: {
    ...mocks,
  },
}));

vi.mock("../services/ocrJobService", () => ({ enqueueAutoOcrForRecord: vi.fn() }));
vi.mock("../services/autoBackupService", () => ({
  flushAutoBackupNow: vi.fn(),
  markAutoBackupDirty: mocks.markAutoBackupDirty,
}));
vi.mock("../services/knowledgePodcastJobService", () => ({
  cancelAllKnowledgePodcastJobs: vi.fn(),
  recoverKnowledgePodcastJobs: vi.fn().mockResolvedValue(undefined),
  subscribeKnowledgePodcastJobs: vi.fn(() => () => undefined),
  syncNativeKnowledgePodcastTtsJobs: vi.fn(),
}));
vi.mock("../services/cloudSyncService", () => ({
  cleanupCloudRecoverySnapshotsIfDue: vi.fn(),
  getCurrentCloudUser: vi.fn(),
}));
vi.mock("../features/reviewCoach/repository", () => ({
  reviewCoachRepository: {
    getFormalSnapshot: mocks.getReviewCoachFormalSnapshot,
    listFeedbackInterpretations: mocks.listFeedbackInterpretations,
  },
}));

import { useAppData } from "./useAppData";

const buildDraft = (recordId: string, contentHtml: string): RecordDraft => {
  const record: RecordBlock = {
    id: recordId,
    createdAt: "2026-09-16T08:00:00.000Z",
    updatedAt: "2026-09-16T08:00:00.000Z",
    type: "record",
    date: "2026-09-16",
    order: 0,
    subject: "读书笔记",
    title: "力学 10 题",
    contentHtml,
    assets: [],
    formulas: [],
    mistakeRefs: [],
    tags: [],
  };
  return {
    id: `draft-${recordId}`,
    recordId,
    baseUpdatedAt: "2026-09-16T08:00:00.000Z",
    draft: record,
    updatedAt: "2026-09-16T08:05:00.000Z",
  };
};

const mount = async () => {
  const { result } = renderHook(() => useAppData());
  await waitFor(() => expect(result.current.initialized).toBe(true));
  return result;
};

describe("useAppData record draft list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRecordDrafts.mockResolvedValue([]);
    mocks.deleteRecordDraft.mockResolvedValue(undefined);
  });

  it("seeds the list from storage on startup", async () => {
    mocks.listRecordDrafts.mockResolvedValue([buildDraft("record-1", "<p>已存草稿</p>")]);
    const result = await mount();

    expect(result.current.recordDrafts.map((item) => item.recordId)).toEqual(["record-1"]);
  });

  it("publishes a saved draft without a full refresh", async () => {
    const result = await mount();
    const draft = buildDraft("record-1", "<p>刚打进去的内容</p>");
    mocks.saveRecordDraft.mockResolvedValue(draft);
    const listingsBeforeSave = mocks.listEntries.mock.calls.length;

    await act(async () => {
      await result.current.saveRecordDraft(draft);
    });

    expect(result.current.recordDrafts.map((item) => item.recordId)).toEqual(["record-1"]);
    expect(result.current.recordDrafts[0]?.draft.contentHtml).toContain("刚打进去的内容");
    // The daily-plan workspace reads this list on every render, so re-listing on
    // each debounced write would be pure overhead - it must not be how the list
    // stays current.
    expect(mocks.listEntries.mock.calls.length).toBe(listingsBeforeSave);
    expect(mocks.markAutoBackupDirty).toHaveBeenCalledWith("record-draft");
  });

  it("keeps one entry per record when the same draft is saved repeatedly", async () => {
    const result = await mount();
    const first = buildDraft("record-1", "<p>第一次</p>");
    const second = buildDraft("record-1", "<p>第二次</p>");
    mocks.saveRecordDraft.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await act(async () => {
      await result.current.saveRecordDraft(first);
    });
    await act(async () => {
      await result.current.saveRecordDraft(second);
    });

    expect(result.current.recordDrafts).toHaveLength(1);
    expect(result.current.recordDrafts[0]?.draft.contentHtml).toContain("第二次");
  });

  it("tracks drafts for several records independently", async () => {
    const result = await mount();
    const one = buildDraft("record-1", "<p>一</p>");
    const two = buildDraft("record-2", "<p>二</p>");
    mocks.saveRecordDraft.mockResolvedValueOnce(one).mockResolvedValueOnce(two);

    await act(async () => {
      await result.current.saveRecordDraft(one);
    });
    await act(async () => {
      await result.current.saveRecordDraft(two);
    });

    expect(result.current.recordDrafts.map((item) => item.recordId)).toEqual(["record-1", "record-2"]);
  });

  it("drops a record from the list once its draft is deleted", async () => {
    mocks.listRecordDrafts.mockResolvedValue([
      buildDraft("record-1", "<p>一</p>"),
      buildDraft("record-2", "<p>二</p>"),
    ]);
    const result = await mount();

    await act(async () => {
      await result.current.deleteRecordDraft("record-1");
    });

    expect(result.current.recordDrafts.map((item) => item.recordId)).toEqual(["record-2"]);
    expect(mocks.deleteRecordDraft).toHaveBeenCalledWith("record-1");
    expect(mocks.markAutoBackupDirty).toHaveBeenCalledWith("record-draft-delete");
  });
});
