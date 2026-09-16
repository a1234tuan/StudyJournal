import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordBlock } from "../types";

const mocks = vi.hoisted(() => ({
  saveBlock: vi.fn(),
  addRecordToReview: vi.fn(),
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
  refresh: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../services/autoBackupService", () => ({ flushAutoBackupNow: vi.fn(), markAutoBackupDirty: mocks.markAutoBackupDirty }));
vi.mock("../services/knowledgePodcastJobService", () => ({
  cancelAllKnowledgePodcastJobs: vi.fn(),
  recoverKnowledgePodcastJobs: vi.fn().mockResolvedValue(undefined),
  subscribeKnowledgePodcastJobs: vi.fn(() => () => undefined),
  syncNativeKnowledgePodcastTtsJobs: vi.fn(),
}));
vi.mock("../services/cloudSyncService", () => ({ cleanupCloudRecoverySnapshotsIfDue: vi.fn(), getCurrentCloudUser: vi.fn() }));
vi.mock("../features/reviewCoach/repository", () => ({
  reviewCoachRepository: {
    getFormalSnapshot: mocks.getReviewCoachFormalSnapshot,
    listFeedbackInterpretations: mocks.listFeedbackInterpretations,
  },
}));

import { useAppData } from "./useAppData";

const savedRecord: RecordBlock = {
  id: "record-1",
  createdAt: "2026-09-04T08:00:00.000Z",
  updatedAt: "2026-09-04T08:00:00.000Z",
  type: "record",
  date: "2026-09-04",
  order: 0,
  subject: "数学",
  title: "复习重点",
  contentHtml: '<record-decision-block data-decision-block-id="block-1" data-content-version="1"><p>内容</p></record-decision-block>',
  assets: [],
  formulas: [],
  mistakeRefs: [],
  tags: [],
};

describe("useAppData decision block enrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveBlock.mockResolvedValue(savedRecord);
    mocks.addRecordToReview.mockResolvedValue(undefined);
  });

  it("enrolls a newly created record that already contains a decision block", async () => {
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.initialized).toBe(true));

    let created!: RecordBlock;
    await act(async () => {
      created = await result.current.createRecordBlock("2026-09-04", "数学", savedRecord.contentHtml);
    });

    expect(created.contentHtml).toContain("record-decision-block");
    expect(created.contentHtml).not.toContain('data-decision-block-id="block-1"');
    expect(created.contentHtml).toContain('data-content-version="1"');
    expect(mocks.addRecordToReview).toHaveBeenCalledWith(created.id);
  });
});
