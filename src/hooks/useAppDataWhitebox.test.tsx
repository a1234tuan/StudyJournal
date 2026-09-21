import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT, type ReviewCoachFormalSnapshot } from "../features/reviewCoach/domain";
import { coachTestBlock, coachTestFeedback, coachTestInterpretation, coachTestQueueItem, coachTestStamp, coachTestTask } from "../features/reviewCoach/reviewCoachTestFixtures";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  rateRecordReview: vi.fn(),
  processFeedbackInterpretationQueue: vi.fn(),
  listEntries: vi.fn().mockResolvedValue([]),
  listBlocks: vi.fn().mockResolvedValue([]),
  listTemplates: vi.fn().mockResolvedValue([]),
  getSettings: vi.fn().mockResolvedValue({ subjects: [], ai: {} }),
  getAiSecret: vi.fn().mockResolvedValue({ apiKey: "test-only" }),
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
  getFormalSnapshot: vi.fn(),
  listFeedbackInterpretations: vi.fn().mockResolvedValue([]),
  saveAiRoleConfig: vi.fn().mockResolvedValue(undefined),
  refreshDueVerifications: vi.fn().mockResolvedValue(0),
  selectNextTask: vi.fn().mockResolvedValue(undefined),
  switchCurrentTask: vi.fn().mockResolvedValue(undefined),
  generateQuizTurn: vi.fn().mockResolvedValue({ id: "new-turn" }),
  analyzeFeedback: vi.fn().mockResolvedValue({ batch: { status: "succeeded" } }),
  markAutoBackupDirty: vi.fn(),
  createQuizExecutionGateway: vi.fn().mockReturnValue({}),
  createSessionPlanningGateway: vi.fn().mockReturnValue({ planSession: vi.fn() }),
  buildAnalysisPlanningBlocks: vi.fn().mockReturnValue([]),
  provider: { id: "desktop-local-provider", providerName: "test-provider", model: "desktop-model" },
}));

vi.mock("../services/storageAdapter", () => ({ storage: mocks }));
vi.mock("../services/ocrJobService", () => ({ enqueueAutoOcrForRecord: vi.fn() }));
vi.mock("../features/reviewCoach/feedbackInterpretationWorker", () => ({ processFeedbackInterpretationQueue: mocks.processFeedbackInterpretationQueue }));
vi.mock("../services/autoBackupService", () => ({ flushAutoBackupNow: vi.fn(), markAutoBackupDirty: mocks.markAutoBackupDirty }));
vi.mock("../services/knowledgePodcastJobService", () => ({
  cancelAllKnowledgePodcastJobs: vi.fn(), recoverKnowledgePodcastJobs: vi.fn(),
  subscribeKnowledgePodcastJobs: vi.fn(() => () => undefined), syncNativeKnowledgePodcastTtsJobs: vi.fn(),
}));
vi.mock("../services/cloudSyncService", () => ({ cleanupCloudRecoverySnapshotsIfDue: vi.fn(), getCurrentCloudUser: vi.fn() }));
vi.mock("../features/reviewCoach/repository", () => ({ reviewCoachRepository: mocks }));
vi.mock("../features/reviewCoach/orchestrator", () => ({
  ReviewCoachOrchestrator: class {
    refreshDueVerifications = mocks.refreshDueVerifications;
    selectNextTask = mocks.selectNextTask;
    switchCurrentTask = mocks.switchCurrentTask;
    generateQuizTurn = mocks.generateQuizTurn;
    analyzeFeedback = mocks.analyzeFeedback;
  },
}));
vi.mock("../lib/aiProviders", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/aiProviders")>(),
  getCurrentAiProvider: () => mocks.provider,
}));
vi.mock("../services/aiContextService", () => ({ buildDecisionBlockAiContextPack: () => ({ markdown: "test material" }) }));
vi.mock("../features/reviewCoach/analysisPlanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../features/reviewCoach/analysisPlanner")>(),
  buildAnalysisPlanningBlocks: mocks.buildAnalysisPlanningBlocks,
}));
vi.mock("../features/reviewCoach/quizExecutionGateway", async (importOriginal) => ({
  ...await importOriginal<typeof import("../features/reviewCoach/quizExecutionGateway")>(),
  createQuizExecutionGateway: mocks.createQuizExecutionGateway,
}));
vi.mock("../features/reviewCoach/sessionPlanningGateway", async (importOriginal) => ({
  ...await importOriginal<typeof import("../features/reviewCoach/sessionPlanningGateway")>(),
  createSessionPlanningGateway: mocks.createSessionPlanningGateway,
}));

import { useAppData } from "./useAppData";

let snapshot: ReviewCoachFormalSnapshot;

const decisionBlockContent = '<record-decision-block data-decision-block-id="decision-block-1" data-content-version="1"><p>test material</p></record-decision-block>';

beforeEach(() => {
  vi.clearAllMocks();
  snapshot = { ...structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT), adaptiveReviewTasks: [{ ...coachTestTask, status: "waiting" }] };
  mocks.getFormalSnapshot.mockImplementation(async () => snapshot);
  mocks.listFeedbackInterpretations.mockImplementation(async () => snapshot.feedbackInterpretations);
  mocks.processFeedbackInterpretationQueue.mockImplementation(async () => [snapshot.feedbackInterpretations[0]]);
  mocks.listBlocks.mockResolvedValue([{ id: coachTestTask.recordId, type: "record", contentHtml: decisionBlockContent, assets: [], formulas: [], tags: [] }]);
});

describe("W-26 interpretation gate across a restart", () => {
  it("leaves an unfinished interpretation to an explicit action after remount", async () => {
    snapshot.decisionBlockFeedback = [{ ...coachTestFeedback, includeInAnalysis: true }];
    snapshot.analysisQueueItems = [{ ...coachTestQueueItem, status: "eligible", consumedAt: undefined, batchId: undefined }];
    snapshot.feedbackInterpretations = [{ ...coachTestInterpretation, status: "failed", errorCode: "network" }];

    const { result, unmount } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.initialized).toBe(true));
    await act(async () => { await result.current.refresh(); window.dispatchEvent(new Event("online")); });
    expect(mocks.processFeedbackInterpretationQueue).not.toHaveBeenCalled();

    unmount();
    const restarted = renderHook(() => useAppData());
    await waitFor(() => expect(restarted.result.current.initialized).toBe(true));
    await act(async () => { await restarted.result.current.refresh(); });
    expect(mocks.processFeedbackInterpretationQueue).not.toHaveBeenCalled();

    // The manual path must still work, otherwise "do not re-run" becomes "cannot run".
    await act(async () => { await restarted.result.current.retryFeedbackInterpretation(coachTestFeedback.id); });
    expect(mocks.processFeedbackInterpretationQueue).toHaveBeenCalledTimes(1);
  });
});

describe("W-27 a read-only session performs no writes", () => {
  it("mounting, refreshing and going back online does not touch any write path", async () => {
    snapshot.decisionBlocks = [structuredClone(coachTestBlock)];
    snapshot.decisionBlockFeedback = [{ ...coachTestFeedback, includeInAnalysis: true }];
    snapshot.analysisQueueItems = [{ ...coachTestQueueItem, status: "eligible", consumedAt: undefined, batchId: undefined }];

    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.initialized).toBe(true));
    await act(async () => {
      await result.current.refresh();
      window.dispatchEvent(new Event("online"));
      await result.current.refresh();
    });

    expect(mocks.rateRecordReview).not.toHaveBeenCalled();
    expect(mocks.saveAiRoleConfig).not.toHaveBeenCalled();
    expect(mocks.switchCurrentTask).not.toHaveBeenCalled();
    expect(mocks.selectNextTask).not.toHaveBeenCalled();
    expect(mocks.analyzeFeedback).not.toHaveBeenCalled();
    expect(mocks.generateQuizTurn).not.toHaveBeenCalled();
    expect(mocks.processFeedbackInterpretationQueue).not.toHaveBeenCalled();
    expect(mocks.markAutoBackupDirty).not.toHaveBeenCalled();
    expect(mocks.getFormalSnapshot).toHaveBeenCalled();

    // Reading the record list is allowed and must not be turned into a write either.
    await act(async () => { await result.current.refresh(); });
    expect(mocks.listBlocks).toHaveBeenCalled();
    expect(mocks.rateRecordReview).not.toHaveBeenCalled();
  });
});

describe("W-27b startup does not resume a task on its own", () => {
  it("keeps the waiting task waiting across mounts and only switches on an explicit request", async () => {
    const first = renderHook(() => useAppData());
    await waitFor(() => expect(first.result.current.initialized).toBe(true));
    first.unmount();
    const second = renderHook(() => useAppData());
    await waitFor(() => expect(second.result.current.initialized).toBe(true));

    expect(mocks.selectNextTask).not.toHaveBeenCalled();
    expect(mocks.switchCurrentTask).not.toHaveBeenCalled();
    expect(snapshot.adaptiveReviewTasks[0].status).toBe("waiting");
    expect(mocks.refreshDueVerifications).toHaveBeenCalledTimes(2);

    await act(async () => { await second.result.current.switchAdaptiveTask(coachTestTask.id); });
    expect(mocks.switchCurrentTask).toHaveBeenCalledWith(coachTestTask.id);
  });
});
