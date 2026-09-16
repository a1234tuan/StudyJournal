import { describe, expect, it } from "vitest";

import type { Asset, DailyPlan, RecordBlock, RecordReviewStatus } from "../types";
import {
  buildDailyPlanViews,
  buildPlanIndex,
  canReclaimPlanRecord,
  groupPlansByDate,
  hasPlanRecordContent,
  isLinkedRecordGone,
  resolvePlanOutcome,
  type PlanContext,
} from "./dailyPlan";

const STAMP = "2026-09-16T00:00:00.000Z";

const plan = (overrides: Partial<DailyPlan> = {}): DailyPlan => ({
  id: "plan-1",
  createdAt: STAMP,
  updatedAt: STAMP,
  date: "2026-09-16",
  subject: "数学",
  title: "三大计算 660 题",
  order: 0,
  ...overrides,
});

const record = (overrides: Partial<RecordBlock> = {}): RecordBlock => ({
  id: "r1",
  createdAt: STAMP,
  updatedAt: STAMP,
  type: "record",
  date: "2026-09-16",
  order: 0,
  subject: "数学",
  tags: [],
  title: "三大计算 660 题",
  contentHtml: "<p></p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
  ...overrides,
});

const decisionBlock = (innerHtml: string): string =>
  `<record-decision-block data-decision-block-id="db-1" data-content-version="1" data-created-at="${STAMP}" data-updated-at="${STAMP}">${innerHtml}</record-decision-block>`;

const context = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  recordsById: new Map<string, RecordBlock>(),
  draftRecordIds: new Set<string>(),
  inFlightDraftRecordIds: new Set<string>(),
  reviewStatuses: new Map<string, RecordReviewStatus>(),
  assets: [] as Asset[],
  ...overrides,
});

describe("hasPlanRecordContent", () => {
  it("treats empty and whitespace-only bodies as no content", () => {
    expect(hasPlanRecordContent(record({ contentHtml: "" }), { assets: [] })).toBe(false);
    expect(hasPlanRecordContent(record({ contentHtml: "<p></p>" }), { assets: [] })).toBe(false);
    expect(hasPlanRecordContent(record({ contentHtml: "<p>   </p>" }), { assets: [] })).toBe(false);
    expect(hasPlanRecordContent(record({ contentHtml: "<p>&nbsp;</p>" }), { assets: [] })).toBe(false);
  });

  it("counts a body with real text", () => {
    expect(hasPlanRecordContent(record({ contentHtml: "<p>今天做了三道题</p>" }), { assets: [] })).toBe(true);
  });

  it("does not let the title alone count as content", () => {
    // The plan title is copied into the record title at creation time. If the
    // title counted, "opened it and went straight back" would read as fulfilled.
    const titled = record({ title: "非常长的计划标题", contentHtml: "<p></p>" });
    expect(hasPlanRecordContent(titled, { assets: [] })).toBe(false);
  });

  it("counts an image-only record even though its plain text is empty", () => {
    const imageOnly = record({
      contentHtml: "",
      assets: [{ id: "a1", title: "草稿纸", kind: "image" }],
    });
    expect(hasPlanRecordContent(imageOnly, { assets: [] })).toBe(true);
  });

  it("counts a formula-only record even though its plain text is empty", () => {
    const formulaOnly = record({ contentHtml: "", formulas: [{ id: "f1", latex: "x^2+y^2" }] });
    expect(hasPlanRecordContent(formulaOnly, { assets: [] })).toBe(true);
  });

  it("counts a tag-only record", () => {
    expect(hasPlanRecordContent(record({ contentHtml: "", tags: ["错题"] }), { assets: [] })).toBe(true);
  });

  it("finds text nested inside a collapse block", () => {
    const collapsed = record({
      contentHtml: `<record-collapse data-title="解析" data-summary="答案"><p>被折叠起来的正文</p></record-collapse>`,
    });
    expect(hasPlanRecordContent(collapsed, { assets: [] })).toBe(true);
  });

  it("treats a record holding only an empty decision block as having no content", () => {
    // This is the counterexample that makes a naive "has a decision block" clause
    // wrong: the block exists, but the user never typed anything into it.
    const emptyDecision = record({ contentHtml: decisionBlock("") });
    expect(hasPlanRecordContent(emptyDecision, { assets: [] })).toBe(false);
  });

  it("counts a decision block that actually holds text", () => {
    const filledDecision = record({ contentHtml: decisionBlock("<p>我决定先做前 20 题</p>") });
    expect(hasPlanRecordContent(filledDecision, { assets: [] })).toBe(true);
  });
});

describe("canReclaimPlanRecord", () => {
  it("allows reclaiming a record with no content and no other claim on it", () => {
    expect(canReclaimPlanRecord(record({ contentHtml: "" }), context())).toBe(true);
  });

  it("refuses to reclaim once there is content", () => {
    expect(canReclaimPlanRecord(record({ contentHtml: "<p>正文</p>" }), context())).toBe(false);
  });

  it("refuses to reclaim while a local draft exists", () => {
    const ctx = context({ draftRecordIds: new Set(["r1"]) });
    expect(canReclaimPlanRecord(record({ contentHtml: "" }), ctx)).toBe(false);
  });

  it("refuses to reclaim while a draft flush is still in flight", () => {
    // "No draft on disk yet" is timing, not evidence that the user wrote nothing.
    const ctx = context({ inFlightDraftRecordIds: new Set(["r1"]) });
    expect(canReclaimPlanRecord(record({ contentHtml: "" }), ctx)).toBe(false);
  });

  it("refuses to reclaim a record already owned by the review queue", () => {
    const ctx = context({ reviewStatuses: new Map<string, RecordReviewStatus>([["r1", "active"]]) });
    expect(canReclaimPlanRecord(record({ contentHtml: "" }), ctx)).toBe(false);
  });

  it("does not treat a mastered or removed review card as blocking", () => {
    for (const status of ["mastered", "removed"] as RecordReviewStatus[]) {
      const ctx = context({ reviewStatuses: new Map<string, RecordReviewStatus>([["r1", status]]) });
      expect(canReclaimPlanRecord(record({ contentHtml: "" }), ctx)).toBe(true);
    }
  });
});

describe("resolvePlanOutcome", () => {
  it("reads a plan that was never opened as pending", () => {
    expect(resolvePlanOutcome(plan(), context())).toBe("pending");
  });

  it("reads a linked plan as done when the log holds content", () => {
    const live = record({ contentHtml: "<p>正文</p>" });
    const ctx = context({ recordsById: new Map([[live.id, live]]) });
    expect(resolvePlanOutcome(plan({ linkedRecordId: "r1" }), ctx)).toBe("done");
  });

  it("reads a linked plan as draft when the log is empty but has a draft", () => {
    const ctx = context({
      recordsById: new Map([["r1", record({ contentHtml: "" })]]),
      draftRecordIds: new Set(["r1"]),
    });
    expect(resolvePlanOutcome(plan({ linkedRecordId: "r1" }), ctx)).toBe("draft");
  });

  it("reads a linked plan as draft while the flush is in flight", () => {
    const ctx = context({
      recordsById: new Map([["r1", record({ contentHtml: "" })]]),
      inFlightDraftRecordIds: new Set(["r1"]),
    });
    expect(resolvePlanOutcome(plan({ linkedRecordId: "r1" }), ctx)).toBe("draft");
  });

  it("reads an empty log with no draft as pending, awaiting the reclaim job", () => {
    const ctx = context({ recordsById: new Map([["r1", record({ contentHtml: "" })]]) });
    expect(resolvePlanOutcome(plan({ linkedRecordId: "r1" }), ctx)).toBe("pending");
  });

  it("never reads an empty log as done", () => {
    const ctx = context({ recordsById: new Map([["r1", record({ contentHtml: "<p></p>" })]]) });
    expect(resolvePlanOutcome(plan({ linkedRecordId: "r1" }), ctx)).not.toBe("done");
  });
});

describe("D8: a deleted log makes the plan read as unfulfilled again", () => {
  it("returns to pending when the linked log is soft-deleted", () => {
    const softDeleted = record({ contentHtml: "<p>正文</p>", deletedAt: STAMP });
    const ctx = context({ recordsById: new Map([[softDeleted.id, softDeleted]]) });
    const subject = plan({ linkedRecordId: "r1" });

    expect(resolvePlanOutcome(subject, ctx)).toBe("pending");
    expect(isLinkedRecordGone(subject, ctx)).toBe(true);
  });

  it("returns to pending when the linked log no longer exists at all", () => {
    const subject = plan({ linkedRecordId: "gone" });
    const ctx = context();

    expect(resolvePlanOutcome(subject, ctx)).toBe("pending");
    expect(isLinkedRecordGone(subject, ctx)).toBe(true);
  });

  it("writes nothing and mutates neither the plan nor its link", () => {
    const subject = plan({ linkedRecordId: "r1" });
    const before = JSON.parse(JSON.stringify(subject));
    const softDeleted = record({ deletedAt: STAMP });
    const ctx = context({ recordsById: new Map([[softDeleted.id, softDeleted]]) });

    resolvePlanOutcome(subject, ctx);
    isLinkedRecordGone(subject, ctx);

    // Restoring the log from trash must return the plan to "done" by itself,
    // which is only possible because the link is still intact.
    expect(subject).toEqual(before);
    expect(subject.linkedRecordId).toBe("r1");
  });

  it("comes back to done as soon as the log is restored", () => {
    const ctx = context({ recordsById: new Map([["r1", record({ contentHtml: "<p>正文</p>" })]]) });
    expect(resolvePlanOutcome(plan({ linkedRecordId: "r1" }), ctx)).toBe("done");
  });
});

describe("isLinkedRecordGone", () => {
  it("stays false for a plan that was never linked, so the hint never nags", () => {
    expect(isLinkedRecordGone(plan(), context())).toBe(false);
  });

  it("stays false while the log is alive", () => {
    const ctx = context({ recordsById: new Map([["r1", record()]]) });
    expect(isLinkedRecordGone(plan({ linkedRecordId: "r1" }), ctx)).toBe(false);
  });
});

describe("buildPlanIndex", () => {
  it("keys by plan id, not by record id", () => {
    const index = buildPlanIndex([plan({ id: "p1", linkedRecordId: "r1" })]);

    expect(index.get("p1")).toMatchObject({ id: "p1", linkedRecordId: "r1" });
    expect(index.get("r1")).toBeUndefined();
  });

  it("resolves a deleted plan when given the live and deleted views together (D9)", () => {
    const deleted = plan({ id: "p2", deletedAt: STAMP, title: "已经删掉的计划" });
    const index = buildPlanIndex([plan({ id: "p1" }), deleted]);

    // This is what lets the editor render "[来自计划·已删除] 数学 · 已经删掉的计划"
    // instead of degrading to a bare "[来自计划]".
    expect(index.get("p2")).toMatchObject({ title: "已经删掉的计划", deletedAt: STAMP });
  });
});

describe("buildDailyPlanViews", () => {
  it("exposes the live record but never a deleted one", () => {
    const live = record({ id: "live", contentHtml: "<p>正文</p>" });
    const deleted = record({ id: "deleted", deletedAt: STAMP });
    const ctx = context({ recordsById: new Map([[live.id, live], [deleted.id, deleted]]) });

    const [liveView, deletedView] = buildDailyPlanViews(
      [plan({ id: "p1", linkedRecordId: "live" }), plan({ id: "p2", order: 1, linkedRecordId: "deleted" })],
      ctx,
    );

    expect(liveView.record?.id).toBe("live");
    expect(liveView.linkedRecordDeleted).toBe(false);
    // A deleted log is not handed to the UI as "the record", so nothing can
    // render its body or read its title.
    expect(deletedView.record).toBeUndefined();
    expect(deletedView.linkedRecordDeleted).toBe(true);
    expect(deletedView.outcome).toBe("pending");
  });

  it("derives outcomes for a whole day in one pass", () => {
    const live = record({ id: "r1", contentHtml: "<p>正文</p>" });
    const ctx = context({ recordsById: new Map([[live.id, live]]) });

    const views = buildDailyPlanViews(
      [
        plan({ id: "p1", linkedRecordId: "r1" }),
        plan({ id: "p2", order: 1 }),
        plan({ id: "p3", order: 2, linkedRecordId: "gone" }),
      ],
      ctx,
    );

    expect(views.map((view) => view.outcome)).toEqual(["done", "pending", "pending"]);
    expect(views.map((view) => view.linkedRecordDeleted)).toEqual([false, false, true]);
  });

  it("does not re-filter soft-deleted plans - the caller's contract decides that", () => {
    // Passing a deleted row in is a caller bug; it must show up as an extra view
    // rather than being silently swallowed and inflating nothing.
    const views = buildDailyPlanViews([plan({ id: "p1", deletedAt: STAMP })], context());
    expect(views).toHaveLength(1);
  });
});

describe("groupPlansByDate", () => {
  const view = (id: string, date: string, order: number, outcome: "done" | "pending" | "draft") =>
    buildDailyPlanViews([plan({ id, date, order, linkedRecordId: outcome === "done" ? id : undefined })], {
      recordsById: new Map([[id, record({ id, contentHtml: outcome === "done" ? "<p>正文</p>" : "" })]]),
      draftRecordIds: outcome === "draft" ? new Set([id]) : new Set<string>(),
      inFlightDraftRecordIds: new Set<string>(),
      reviewStatuses: new Map<string, RecordReviewStatus>(),
      assets: [],
    })[0];

  it("orders days newest first and plans by their order within a day", () => {
    const groups = groupPlansByDate([
      view("a", "2026-09-14", 0, "pending"),
      view("b", "2026-09-16", 2, "pending"),
      view("c", "2026-09-16", 0, "done"),
      view("d", "2026-09-15", 1, "pending"),
    ]);

    expect(groups.map((group) => group.date)).toEqual(["2026-09-16", "2026-09-15", "2026-09-14"]);
    expect(groups[0].views.map((item) => item.plan.id)).toEqual(["c", "b"]);
  });

  it("tallies done against total per day", () => {
    const groups = groupPlansByDate([
      view("a", "2026-09-16", 0, "done"),
      view("b", "2026-09-16", 1, "pending"),
      view("c", "2026-09-16", 2, "done"),
      view("d", "2026-09-16", 3, "draft"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ doneCount: 2, totalCount: 4 });
  });

  it("omits days that have no plans", () => {
    const groups = groupPlansByDate([view("a", "2026-09-16", 0, "pending")]);

    expect(groups.map((group) => group.date)).toEqual(["2026-09-16"]);
    expect(groups.some((group) => group.date === "2026-09-15")).toBe(false);
  });

  it("returns nothing for no views", () => {
    expect(groupPlansByDate([])).toEqual([]);
  });
});
