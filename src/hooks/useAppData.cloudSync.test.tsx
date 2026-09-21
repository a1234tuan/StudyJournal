import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT, type AiRoleConfig, type ReviewCoachFormalSnapshot } from "../features/reviewCoach/domain";
import { coachTestBlock, coachTestTask, coachTestStamp, coachTestFeedback, coachTestQueueItem, coachTestInterpretation } from "../features/reviewCoach/reviewCoachTestFixtures";

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
  createQuizExecutionGateway: vi.fn().mockReturnValue({}),
  createSessionPlanningGateway: vi.fn().mockReturnValue({ planSession: vi.fn() }),
  buildAnalysisPlanningBlocks: vi.fn().mockReturnValue([]),
  provider: { id: "desktop-local-provider", providerName: "test-provider", model: "desktop-model" },
}));

vi.mock("../services/storageAdapter", () => ({ storage: mocks }));
vi.mock("../services/ocrJobService", () => ({ enqueueAutoOcrForRecord: vi.fn() }));
vi.mock("../features/reviewCoach/feedbackInterpretationWorker", () => ({ processFeedbackInterpretationQueue: mocks.processFeedbackInterpretationQueue }));
vi.mock("../services/autoBackupService", () => ({ flushAutoBackupNow: vi.fn(), markAutoBackupDirty: vi.fn() }));
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

const roleConfig: AiRoleConfig = {
  id: "ai-role:turn-generator", role: "turn-generator", providerId: "phone-local-provider", model: "phone-model",
  enabled: true, promptVersion: "saved-prompt", policyVersion: "saved-policy", schemaVersion: 1,
  timeoutMs: 42000, maxRetries: 0, maxConcurrency: 1, createdAt: coachTestStamp, updatedAt: coachTestStamp,
};

let snapshot: ReviewCoachFormalSnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  snapshot = { ...structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT), adaptiveReviewTasks: [{ ...coachTestTask, status: "waiting" }], aiRoleConfigs: [roleConfig] };
  mocks.getFormalSnapshot.mockImplementation(async () => snapshot);
  mocks.listFeedbackInterpretations.mockImplementation(async () => snapshot.feedbackInterpretations);
  mocks.processFeedbackInterpretationQueue.mockImplementation(async () => {
    snapshot.feedbackInterpretations = [coachTestInterpretation];
    return [coachTestInterpretation];
  });
  mocks.listBlocks.mockResolvedValue([{ id: coachTestTask.recordId, type: "record", contentHtml: "<p>test material</p>", assets: [], formulas: [], tags: [] }]);
  mocks.buildAnalysisPlanningBlocks.mockReturnValue([]);
});

describe("useAppData cloud sync write boundaries", () => {
  it("does not automatically interpret feedback received on startup, refresh or reconnect", async () => {
    snapshot.decisionBlockFeedback = [{ ...coachTestFeedback, includeInAnalysis: true }];
    snapshot.analysisQueueItems = [{ ...coachTestQueueItem, status: "eligible", consumedAt: undefined, batchId: undefined }];
    mocks.listBlocks.mockResolvedValue([{ id: coachTestTask.recordId, type: "record", contentHtml: '<record-decision-block data-decision-block-id="decision-block-1" data-content-version="1"><p>test material</p></record-decision-block>', assets: [], formulas: [], tags: [] }]);
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.initialized).toBe(true));
    await act(async () => { await result.current.refresh(); window.dispatchEvent(new Event("online")); });
    expect(mocks.processFeedbackInterpretationQueue).not.toHaveBeenCalled();
    await act(async () => { await result.current.retryFeedbackInterpretation(coachTestFeedback.id); });
    expect(mocks.processFeedbackInterpretationQueue).toHaveBeenCalledTimes(1);
  });

  it("automatically interprets newly submitted local feedback and resumes it after reconnect", async () => {
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.initialized).toBe(true));
    mocks.listBlocks.mockResolvedValue([{ id: coachTestTask.recordId, type: "record", contentHtml: '<record-decision-block data-decision-block-id="decision-block-1" data-content-version="1"><p>test material</p></record-decision-block>', assets: [], formulas: [], tags: [] }]);
    await act(async () => { await result.current.refresh(); });
    mocks.rateRecordReview.mockImplementation(async () => {
      snapshot.decisionBlockFeedback = [{ ...coachTestFeedback, reviewLogId: "new-review-log" }];
      snapshot.analysisQueueItems = [{ ...coachTestQueueItem, status: "eligible", consumedAt: undefined, batchId: undefined }];
      return { log: { id: "new-review-log" }, undoToken: { decisionBlockFeedbackIds: [coachTestFeedback.id] } };
    });
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    await act(async () => { await result.current.rateRecordReview(coachTestTask.recordId, "good"); });
    expect(mocks.processFeedbackInterpretationQueue).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(mocks.processFeedbackInterpretationQueue).toHaveBeenCalledTimes(1));
    online.mockRestore();
  });
  it("refreshes due verifications without selecting a task on startup or remount", async () => {
    const first = renderHook(() => useAppData());
    await waitFor(() => expect(first.result.current.initialized).toBe(true));
    first.unmount();
    const second = renderHook(() => useAppData());
    await waitFor(() => expect(second.result.current.initialized).toBe(true));
    expect(mocks.refreshDueVerifications).toHaveBeenCalledTimes(2);
    expect(mocks.selectNextTask).not.toHaveBeenCalled();
    expect(snapshot.adaptiveReviewTasks[0].status).toBe("waiting");
    await act(async () => { await second.result.current.switchAdaptiveTask(coachTestTask.id); });
    expect(mocks.switchCurrentTask).toHaveBeenCalledWith(coachTestTask.id);
  });

  it("uses fresh saved role timeouts without overwriting cloud roles with local provider bindings", async () => {
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.initialized).toBe(true));
    snapshot = { ...snapshot, aiRoleConfigs: [{ ...roleConfig, timeoutMs: 17000 }] };
    await act(async () => { await result.current.generateAdaptiveQuizTurn(coachTestTask.id); });
    expect(mocks.createQuizExecutionGateway).toHaveBeenCalledWith(expect.objectContaining({
      provider: mocks.provider,
      roleTimeouts: { "turn-generator": 17000, "question-quality-reviewer": 60000, "answer-evaluator": 60000 },
    }));
    expect(mocks.generateQuizTurn).toHaveBeenCalledWith(expect.objectContaining({ provider: "test-provider", model: "desktop-model" }));
    expect(mocks.saveAiRoleConfig).not.toHaveBeenCalled();
    expect(snapshot.aiRoleConfigs[0].providerId).toBe("phone-local-provider");
  });

  it("uses runtime defaults without seeding shared role rows on either device", async () => {
    snapshot.aiRoleConfigs = [];
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.initialized).toBe(true));
    await act(async () => {
      await result.current.generateAdaptiveQuizTurn(coachTestTask.id);
      await result.current.generateAdaptiveQuizTurn(coachTestTask.id);
    });
    expect(mocks.createQuizExecutionGateway).toHaveBeenLastCalledWith(expect.objectContaining({
      roleTimeouts: { "turn-generator": 60000, "question-quality-reviewer": 60000, "answer-evaluator": 60000 },
    }));
    expect(mocks.saveAiRoleConfig).not.toHaveBeenCalled();
    expect(snapshot.aiRoleConfigs).toEqual([]);
  });

  it("keeps planning provider metadata in the analysis operation rather than rewriting a shared role", async () => {
    mocks.buildAnalysisPlanningBlocks.mockReturnValue([{ decisionBlockId: coachTestBlock.id }]);
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.initialized).toBe(true));
    await act(async () => { await result.current.runDeepAnalysis([coachTestBlock.id], false); });
    expect(mocks.analyzeFeedback).toHaveBeenCalledWith(expect.objectContaining({ provider: "test-provider", model: "desktop-model" }));
    expect(mocks.saveAiRoleConfig).not.toHaveBeenCalled();
  });
});
