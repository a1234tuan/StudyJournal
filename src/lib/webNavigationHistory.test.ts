import { describe, expect, it } from "vitest";

import { createInitialTabMemory, MORE_SUB_ROUTE_VALUES } from "./tabNavigation";
import {
  createWebNavigationSnapshot,
  isCurrentWebNavigationSession,
  restoreWebNavigationSnapshot,
} from "./webNavigationHistory";

describe("web navigation history snapshots", () => {
  it("round-trips tab state, reference navigation and scroll position through browser-safe JSON", () => {
    const memory = createInitialTabMemory();
    memory.journal.month = new Date("2026-07-01T00:00:00.000Z");
    memory.journal.selectedDate = "2026-07-22";
    memory.journal.selectedSubject = "数学";
    memory.journal.searchOpen = true;
    memory.journal.searchQuery = "二重积分";
    memory.journal.recordId = "record-b";
    memory.journal.referenceStack = [{ kind: "record", recordId: "record-a", recordEditing: true, scrollY: 248 }];
    memory.more.subRoute = "recordings";
    memory.more.aiScreen = "scope";
    memory.more.recordingsState = {
      selectedFolderId: "subject:英语",
      playerAssetId: "audio-1",
      query: "听力",
      searchOpen: true,
    };

    const snapshot = createWebNavigationSnapshot("session-1", "journal", memory, "ai-session-1", 384, 7);
    const restored = restoreWebNavigationSnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(restored).toEqual({
      ...snapshot,
      tabMemory: {
        ...memory,
        journal: {
          ...memory.journal,
          month: new Date("2026-07-01T00:00:00.000Z"),
        },
      },
    });
    expect(restored?.tabMemory.journal.month).toBeInstanceOf(Date);
    expect(restored?.tabMemory.journal.referenceStack?.[0]).toMatchObject({ recordId: "record-a", scrollY: 248 });
    expect(restored?.navigationIndex).toBe(7);
  });

  it("restores every More sub-route and degrades an unknown one to the More root", () => {
    for (const subRoute of MORE_SUB_ROUTE_VALUES) {
      const memory = createInitialTabMemory();
      memory.more.subRoute = subRoute;
      const snapshot = createWebNavigationSnapshot("session-1", "more", memory, null, 0);
      const restored = restoreWebNavigationSnapshot(JSON.parse(JSON.stringify(snapshot)));
      expect(restored, `sub-route ${subRoute} must survive a browser Back`).not.toBeNull();
      expect(restored?.tabMemory.more.subRoute).toBe(subRoute);
    }

    const stale = createInitialTabMemory();
    stale.more.subRoute = "removed-route" as never;
    const staleSnapshot = createWebNavigationSnapshot("session-1", "more", stale, null, 0);
    const restoredStale = restoreWebNavigationSnapshot(JSON.parse(JSON.stringify(staleSnapshot)));
    expect(restoredStale).not.toBeNull();
    expect(restoredStale?.tabMemory.more.subRoute).toBeNull();
  });

  it("restores card-library scope, filters and sorting while accepting legacy snapshots", () => {
    const memory = createInitialTabMemory();
    memory.review.library = {
      scope: { kind: "tag", subject: "数据结构", tag: "图论" },
      filter: "due",
      kindFilter: "memory",
      query: "最短路",
      sort: "reviewed",
    };
    memory.review.reviewProgress = { total: 14, completed: 6 };

    const snapshot = createWebNavigationSnapshot("session-1", "review", memory, null, 0);
    const restored = restoreWebNavigationSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(restored?.tabMemory.review.library).toEqual(memory.review.library);
    expect(restored?.tabMemory.review.reviewProgress).toEqual({ total: 14, completed: 6 });

    const legacySnapshot = JSON.parse(JSON.stringify(snapshot));
    delete legacySnapshot.tabMemory.review.library;
    delete legacySnapshot.navigationIndex;
    expect(restoreWebNavigationSnapshot(legacySnapshot)?.tabMemory.review.library).toEqual(createInitialTabMemory().review.library);
    expect(restoreWebNavigationSnapshot(legacySnapshot)?.navigationIndex).toBe(0);
  });

  it("round-trips the bounded voice recall route without serialising runtime data", () => {
    const memory = createInitialTabMemory();
    memory.review.voiceRecall = {
      screen: "call",
      returnTab: "review",
      sourceKind: "review-card",
      recordIds: ["record-1"],
      sessionId: "voice-session-1",
      learningGoal: "闭卷解释核心概念",
    };

    const snapshot = createWebNavigationSnapshot("session-1", "review", memory, null, 0);
    const restored = restoreWebNavigationSnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(restored?.tabMemory.review.voiceRecall).toEqual(memory.review.voiceRecall);
    expect(JSON.stringify(snapshot)).not.toContain("providerFinalText");
    expect(JSON.stringify(snapshot)).not.toContain("confirmedText");
  });

  it("rejects malformed or oversized voice recall routes", () => {
    const memory = createInitialTabMemory();
    memory.review.voiceRecall = {
      screen: "start",
      returnTab: "review",
      sourceKind: "review-home",
      recordIds: [],
    };
    const snapshot = createWebNavigationSnapshot("session-1", "review", memory, null, 0);
    const malformed = JSON.parse(JSON.stringify(snapshot));
    malformed.tabMemory.review.voiceRecall.screen = "unknown";
    expect(restoreWebNavigationSnapshot(malformed)?.tabMemory.review.voiceRecall).toBeUndefined();

    const oversized = JSON.parse(JSON.stringify(snapshot));
    oversized.tabMemory.review.voiceRecall.recordIds = Array.from({ length: 11 }, (_, index) => `record-${index}`);
    expect(restoreWebNavigationSnapshot(oversized)?.tabMemory.review.voiceRecall).toBeUndefined();
  });

  it("rejects foreign, stale or malformed history state", () => {
    const snapshot = createWebNavigationSnapshot("session-1", "today", createInitialTabMemory(), null, 0);

    expect(restoreWebNavigationSnapshot({ ...snapshot, kind: "other-app" })).toBeNull();
    expect(restoreWebNavigationSnapshot({ ...snapshot, version: 999 })).toBeNull();
    expect(restoreWebNavigationSnapshot({ ...snapshot, tabMemory: { ...snapshot.tabMemory, journal: { ...snapshot.tabMemory.journal, month: "not-a-date" } } })).toBeNull();
    expect(restoreWebNavigationSnapshot({ ...snapshot, scrollY: -1 })).toBeNull();
  });

  it("recognises only the current application navigation session", () => {
    const snapshot = createWebNavigationSnapshot("current-session", "more", createInitialTabMemory(), null, 24);

    expect(isCurrentWebNavigationSession(snapshot, "current-session")).toBe(true);
    expect(isCurrentWebNavigationSession(snapshot, "other-session")).toBe(false);
    expect(isCurrentWebNavigationSession({}, "current-session")).toBe(false);
  });
});
