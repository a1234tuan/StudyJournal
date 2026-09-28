import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT } from "../features/reviewCoach/domain";
import { addDaysISO, todayISO } from "../lib/date";
import type { DailyPlan, RecordBlock } from "../types";

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
  getDailyPlan: vi.fn(),
  saveDailyPlan: vi.fn(),
  saveBlock: vi.fn().mockResolvedValue(undefined),
  linkPlanRecord: vi.fn().mockResolvedValue(undefined),
  addRecordToReview: vi.fn(),
  saveRecordDraft: vi.fn(),
  markAutoBackupDirty: vi.fn().mockResolvedValue(undefined),
  getFormalSnapshot: vi.fn(),
  listFeedbackInterpretations: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/storageAdapter", () => ({ storage: mocks }));
vi.mock("../services/ocrJobService", () => ({ enqueueAutoOcrForRecord: vi.fn() }));
vi.mock("../services/autoBackupService", () => ({ flushAutoBackupNow: vi.fn(), markAutoBackupDirty: mocks.markAutoBackupDirty }));
vi.mock("../services/knowledgePodcastJobService", () => ({
  cancelAllKnowledgePodcastJobs: vi.fn(), recoverKnowledgePodcastJobs: vi.fn(),
  subscribeKnowledgePodcastJobs: vi.fn(() => () => undefined), syncNativeKnowledgePodcastTtsJobs: vi.fn(),
}));
vi.mock("../services/cloudSyncService", () => ({ cleanupCloudRecoverySnapshotsIfDue: vi.fn(), getCurrentCloudUser: vi.fn() }));
vi.mock("../features/reviewCoach/repository", () => ({ reviewCoachRepository: mocks }));

import { useAppData } from "./useAppData";

const makePlan = (overrides: Partial<DailyPlan> = {}): DailyPlan => ({
  id: "plan-1", createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z",
  date: todayISO(), subject: "数学", title: "安排学习", order: 0, ...overrides,
});

const mount = async () => {
  const { result } = renderHook(useAppData);
  await waitFor(() => expect(result.current.initialized).toBe(true));
  return result;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFormalSnapshot.mockResolvedValue(structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT));
  mocks.getDailyPlan.mockResolvedValue(makePlan());
  mocks.listDailyPlans.mockResolvedValue([]);
  mocks.listBlocks.mockResolvedValue([]);
  mocks.saveDailyPlan.mockImplementation(async (plan: DailyPlan) => plan);
});

describe("useAppData scheduled plans", () => {
  it("creates a future plan and schedules backup without writing a record, draft or review", async () => {
    const result = await mount();
    const date = addDaysISO(todayISO(), 3);
    mocks.listDailyPlans.mockResolvedValue([makePlan({ date, order: 2 })]);
    await act(async () => { await result.current.createDailyPlan({ date, subject: "英语", title: "未来安排" }); });
    expect(mocks.saveDailyPlan).toHaveBeenCalledWith(expect.objectContaining({ date, subject: "英语", title: "未来安排", order: 3 }));
    expect(mocks.markAutoBackupDirty).toHaveBeenCalledWith("daily-plan-save");
    expect(mocks.saveBlock).not.toHaveBeenCalled();
    expect(mocks.saveRecordDraft).not.toHaveBeenCalled();
    expect(mocks.addRecordToReview).not.toHaveBeenCalled();
    expect(mocks.linkPlanRecord).not.toHaveBeenCalled();
  });

  it.each(["2026-02-30", "", "2026-9-28", "0000-01-01"])("rejects an invalid creation date %s before writing", async (date) => {
    const result = await mount();
    await expect(result.current.createDailyPlan({ date, subject: "数学", title: "无效安排" })).rejects.toThrow("有效日期");
    expect(mocks.saveDailyPlan).not.toHaveBeenCalled();
    expect(mocks.markAutoBackupDirty).not.toHaveBeenCalled();
  });

  it("rejects creating a past plan", async () => {
    const result = await mount();
    await expect(result.current.createDailyPlan({ date: addDaysISO(todayISO(), -1), subject: "数学", title: "过期安排" })).rejects.toThrow("有效日期");
    expect(mocks.saveDailyPlan).not.toHaveBeenCalled();
  });

  it("checks the latest plan date rather than a stale caller before creating a log", async () => {
    const stale = makePlan();
    mocks.getDailyPlan.mockResolvedValue(makePlan({ date: addDaysISO(todayISO(), 2) }));
    const result = await mount();
    await expect(result.current.openRecordFromPlan(stale)).rejects.toThrow("尚未到日期");
    expect(mocks.saveBlock).not.toHaveBeenCalled();
    expect(mocks.linkPlanRecord).not.toHaveBeenCalled();
    expect(mocks.markAutoBackupDirty).not.toHaveBeenCalled();
  });

  it.each([undefined, makePlan({ deletedAt: "2026-09-28T00:00:00.000Z" }), makePlan({ date: "2026-02-30" })])("rejects a missing, deleted or malformed current plan", async (current) => {
    mocks.getDailyPlan.mockResolvedValue(current);
    const result = await mount();
    await expect(result.current.openRecordFromPlan(makePlan())).rejects.toThrow();
    expect(mocks.saveBlock).not.toHaveBeenCalled();
    expect(mocks.linkPlanRecord).not.toHaveBeenCalled();
  });

  it.each([0, -2])("creates an arrived plan's log at its original date (offset %s)", async (offset) => {
    const current = makePlan({ date: addDaysISO(todayISO(), offset), title: "最新标题" });
    mocks.getDailyPlan.mockResolvedValue(current);
    const result = await mount();
    let record: RecordBlock | undefined;
    await act(async () => { record = await result.current.openRecordFromPlan(makePlan({ date: addDaysISO(todayISO(), 3) })); });
    expect(record).toMatchObject({ date: current.date, subject: current.subject, title: "最新标题", planId: current.id });
    expect(mocks.saveBlock).toHaveBeenCalledOnce();
    expect(mocks.linkPlanRecord).toHaveBeenCalledWith(current.id, record?.id);
  });

  it("reuses the latest linked record even when the caller lacks the link", async () => {
    const current = makePlan({ linkedRecordId: "record-1" });
    const record = { id: "record-1", type: "record", date: current.date };
    mocks.getDailyPlan.mockResolvedValue(current);
    mocks.listBlocks.mockResolvedValue([record]);
    const result = await mount();
    expect(await result.current.openRecordFromPlan(makePlan())).toBe(record);
    expect(mocks.saveBlock).not.toHaveBeenCalled();
  });
});
