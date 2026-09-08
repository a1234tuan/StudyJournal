import { describe, expect, it } from "vitest";

import { buildTabPageKey, createInitialTabMemory, getTabDepth, popTabDepth, recordReferenceOpenError, reviewQueueReferenceOpenError } from "./tabNavigation";

describe("tabNavigation", () => {
  it("treats the voice recall workspace as one review-owned navigation layer", () => {
    const memory = createInitialTabMemory();
    memory.review.currentRecordId = "record-1";
    memory.review.queueIds = ["record-1", "record-2"];
    memory.review.reviewProgress = { total: 2, completed: 0 };
    memory.review.voiceRecall = {
      screen: "call",
      returnTab: "review",
      sourceKind: "review-card",
      recordIds: ["record-1"],
      sessionId: "voice-session-1",
    };

    expect(getTabDepth("review", memory)).toBe(1);
    expect(buildTabPageKey("review", memory)).toContain("voice-call-voice-session-1");

    const returned = popTabDepth(memory, "review");
    expect(returned.review.voiceRecall).toBeUndefined();
    expect(returned.review.currentRecordId).toBe("record-1");
    expect(returned.review.queueIds).toEqual(["record-1", "record-2"]);
    expect(returned.review.reviewProgress).toEqual({ total: 2, completed: 0 });
  });

  it("keeps each tab state independent", () => {
    const memory = createInitialTabMemory();
    const next = {
      ...memory,
      today: { recordId: "today-record", recordEditing: true },
      categories: { ...memory.categories, activeSubject: "数学" },
      review: { ...memory.review, queueIds: ["review-record"], currentRecordId: "review-record" },
      more: { ...memory.more, recordingsState: { ...memory.more.recordingsState, query: "同步录音", searchOpen: true } },
    };

    expect(getTabDepth("today", next)).toBe(1);
    expect(getTabDepth("categories", next)).toBe(1);
    expect(getTabDepth("review", next)).toBe(0);
    expect(next.more.recordingsState.query).toBe("同步录音");
  });

  it("pops only the current tab record depth", () => {
    const memory = {
      ...createInitialTabMemory(),
      today: { recordId: "today-record", recordEditing: true },
      categories: { ...createInitialTabMemory().categories, recordId: "category-record", activeSubject: "英语" },
    };

    const next = popTabDepth(memory, "today");

    expect(next.today.recordId).toBeUndefined();
    expect(next.today.recordEditing).toBeUndefined();
    expect(next.categories.recordId).toBe("category-record");
    expect(next.categories.activeSubject).toBe("英语");
  });

  it("returns through record references before closing the source record", () => {
    const memory = {
      ...createInitialTabMemory(),
      today: {
        recordId: "record-target",
        recordEditing: false,
        referenceStack: [{ kind: "record" as const, recordId: "record-source", recordEditing: false, scrollY: 384 }],
      },
    };

    expect(getTabDepth("today", memory)).toBe(2);

    const returned = popTabDepth(memory, "today");
    expect(returned.today.recordId).toBe("record-source");
    expect(returned.today.referenceStack).toEqual([]);
    expect(returned.today.restoreScrollY).toBe(384);
    expect(getTabDepth("today", returned)).toBe(1);

    const closed = popTabDepth(returned, "today");
    expect(closed.today.recordId).toBeUndefined();
  });

  it("blocks circular and over-limit reference navigation", () => {
    const cycle = {
      ...createInitialTabMemory(),
      today: {
        recordId: "record-b",
        referenceStack: [{ kind: "record" as const, recordId: "record-a", scrollY: 0 }],
      },
    };
    const tooDeep = {
      ...createInitialTabMemory(),
      today: {
        recordId: "record-9",
        referenceStack: Array.from({ length: 8 }, (_, index) => ({ kind: "record" as const, recordId: `record-${index}`, scrollY: 0 })),
      },
    };

    expect(recordReferenceOpenError(cycle.today, "record-a")).toBe("cycle");
    expect(recordReferenceOpenError(tooDeep.today, "record-10")).toBe("depth");
    expect(recordReferenceOpenError(cycle.today, "record-c")).toBeUndefined();
  });

  it("returns a referenced record to its review queue card without changing review state", () => {
    const memory = {
      ...createInitialTabMemory(),
      review: {
        ...createInitialTabMemory().review,
        queueIds: ["record-source", "record-next"],
        currentRecordId: "record-source",
        recordId: "record-target",
        referenceStack: [{ kind: "review-queue" as const, sourceRecordId: "record-source", scrollY: 264 }],
      },
    };

    expect(getTabDepth("review", memory)).toBe(2);
    expect(reviewQueueReferenceOpenError(memory.review, "record-source", "record-source")).toBe("cycle");

    const returned = popTabDepth(memory, "review");
    expect(returned.review.recordId).toBeUndefined();
    expect(returned.review.currentRecordId).toBe("record-source");
    expect(returned.review.queueIds).toEqual(["record-source", "record-next"]);
    expect(returned.review.referenceStack).toEqual([]);
    expect(returned.review.restoreScrollY).toBe(264);
    expect(getTabDepth("review", returned)).toBe(0);
  });

  it("unwinds nested record references back to the original review queue", () => {
    const memory = {
      ...createInitialTabMemory(),
      review: {
        ...createInitialTabMemory().review,
        queueIds: ["record-source"],
        currentRecordId: "record-source",
        recordId: "record-c",
        referenceStack: [
          { kind: "review-queue" as const, sourceRecordId: "record-source", scrollY: 120 },
          { kind: "record" as const, recordId: "record-b", scrollY: 0 },
        ],
      },
    };

    const backToFirstTarget = popTabDepth(memory, "review");
    expect(backToFirstTarget.review.recordId).toBe("record-b");
    expect(backToFirstTarget.review.referenceStack).toHaveLength(1);

    const backToQueue = popTabDepth(backToFirstTarget, "review");
    expect(backToQueue.review.recordId).toBeUndefined();
    expect(backToQueue.review.currentRecordId).toBe("record-source");
    expect(backToQueue.review.restoreScrollY).toBe(120);
  });

  it("returns journal subject records to the selected day first", () => {
    const memory = {
      ...createInitialTabMemory(),
      journal: {
        ...createInitialTabMemory().journal,
        selectedDate: "2026-06-23",
        selectedSubject: "政治",
      },
    };

    const next = popTabDepth(memory, "journal");

    expect(getTabDepth("journal", next)).toBe(1);
    expect(next.journal.selectedDate).toBe("2026-06-23");
    expect(next.journal.selectedSubject).toBeUndefined();
  });

  it("returns journal selected day to the root layer", () => {
    const memory = {
      ...createInitialTabMemory(),
      journal: {
        ...createInitialTabMemory().journal,
        selectedDate: "2026-06-23",
      },
    };

    const next = popTabDepth(memory, "journal");

    expect(getTabDepth("journal", next)).toBe(0);
    expect(next.journal.selectedDate).toBeUndefined();
  });

  it("returns journal search result records to the journal search page", () => {
    const memory = {
      ...createInitialTabMemory(),
      journal: {
        ...createInitialTabMemory().journal,
        searchOpen: true,
        searchQuery: "B树",
        recordId: "record-1",
        highlightAssetId: "asset-1",
      },
    };

    const next = popTabDepth(memory, "journal");

    expect(next.journal.recordId).toBeUndefined();
    expect(next.journal.highlightAssetId).toBeUndefined();
    expect(next.journal.searchOpen).toBe(true);
    expect(next.journal.searchQuery).toBe("B树");
  });

  it("closes journal search without losing the search query", () => {
    const memory = {
      ...createInitialTabMemory(),
      journal: {
        ...createInitialTabMemory().journal,
        searchOpen: true,
        searchQuery: "进程同步",
      },
    };

    const next = popTabDepth(memory, "journal");

    expect(next.journal.searchOpen).toBe(false);
    expect(next.journal.searchQuery).toBe("进程同步");
  });

  it("keeps review queue as root-level tab state", () => {
    const memory = {
      ...createInitialTabMemory(),
      review: { ...createInitialTabMemory().review, queueIds: ["record-1"], currentRecordId: "record-1" },
    };

    const next = popTabDepth(memory, "review");

    expect(next.review.queueIds).toEqual(["record-1"]);
    expect(next.review.currentRecordId).toBe("record-1");
  });

  it("keeps review root page key stable when only the review queue changes", () => {
    const base = {
      ...createInitialTabMemory(),
      review: { ...createInitialTabMemory().review, queueIds: ["record-1"], currentRecordId: "record-1" },
    };
    const changedQueue = {
      ...base,
      review: { ...base.review, queueIds: ["record-2", "record-3"], currentRecordId: "record-2" },
    };

    expect(buildTabPageKey("review", changedQueue)).toBe(buildTabPageKey("review", base));
  });

  it("changes review page key for mode changes and record detail depth", () => {
    const base = createInitialTabMemory();
    const manage = {
      ...base,
      review: { ...base.review, mode: "manage" as const },
    };
    const recordDetail = {
      ...base,
      review: { ...base.review, recordId: "record-1" },
    };

    expect(buildTabPageKey("review", manage)).not.toBe(buildTabPageKey("review", base));
    expect(buildTabPageKey("review", recordDetail)).not.toBe(buildTabPageKey("review", base));
  });

  it("opens and pops record depth inside review tab", () => {
    const memory = {
      ...createInitialTabMemory(),
      review: { ...createInitialTabMemory().review, recordId: "record-1", recordEditing: true },
    };

    expect(getTabDepth("review", memory)).toBe(1);

    const next = popTabDepth(memory, "review");

    expect(getTabDepth("review", next)).toBe(0);
    expect(next.review.recordId).toBeUndefined();
    expect(next.review.recordEditing).toBeUndefined();
  });

  it("stores recordings state under More", () => {
    const memory = {
      ...createInitialTabMemory(),
      more: {
        ...createInitialTabMemory().more,
        subRoute: "recordings" as const,
        recordingsState: {
          ...createInitialTabMemory().more.recordingsState,
          query: "讲解",
          searchOpen: true,
        },
      },
    };

    const next = popTabDepth(memory, "more");

    expect(next.more.subRoute).toBe("recordings");
    expect(next.more.recordingsState.searchOpen).toBe(false);
    expect(next.more.recordingsState.query).toBe("讲解");
    expect(popTabDepth(next, "more").more.subRoute).toBeNull();
  });

  it("unwinds recording player, folder and search before leaving the recordings page", () => {
    const playerMemory = {
      ...createInitialTabMemory(),
      more: {
        ...createInitialTabMemory().more,
        subRoute: "recordings" as const,
        recordingsState: {
          selectedFolderId: "subject:英语",
          playerAssetId: "audio-1",
          query: "听力",
          searchOpen: true,
        },
      },
    };

    expect(getTabDepth("more", playerMemory)).toBe(3);

    const folder = popTabDepth(playerMemory, "more");
    expect(folder.more.recordingsState.playerAssetId).toBeUndefined();
    expect(getTabDepth("more", folder)).toBe(2);

    const recordings = popTabDepth(folder, "more");
    expect(recordings.more.recordingsState.selectedFolderId).toBeUndefined();
    expect(getTabDepth("more", recordings)).toBe(2);

    const rootRecordings = popTabDepth(recordings, "more");
    expect(rootRecordings.more.recordingsState.searchOpen).toBe(false);
    expect(getTabDepth("more", rootRecordings)).toBe(1);

    expect(popTabDepth(rootRecordings, "more").more.subRoute).toBeNull();
  });

  it("pops more subpages back to the More root", () => {
    const memory = {
      ...createInitialTabMemory(),
      more: {
        ...createInitialTabMemory().more,
        subRoute: "settings" as const,
      },
    };

    const next = popTabDepth(memory, "more");

    expect(getTabDepth("more", next)).toBe(0);
    expect(next.more.subRoute).toBeNull();
  });

  it("treats More backup, AI tools, OCR settings and guide as subpages", () => {
    const backupMemory = {
      ...createInitialTabMemory(),
      more: { ...createInitialTabMemory().more, subRoute: "backup" as const },
    };
    const aiToolsMemory = {
      ...createInitialTabMemory(),
      more: { ...createInitialTabMemory().more, subRoute: "aiTools" as const },
    };
    const ocrSettingsMemory = {
      ...createInitialTabMemory(),
      more: { ...createInitialTabMemory().more, subRoute: "ocrSettings" as const },
    };
    const guideMemory = {
      ...createInitialTabMemory(),
      more: { ...createInitialTabMemory().more, subRoute: "guide" as const },
    };

    expect(getTabDepth("more", backupMemory)).toBe(1);
    expect(getTabDepth("more", aiToolsMemory)).toBe(1);
    expect(getTabDepth("more", ocrSettingsMemory)).toBe(1);
    expect(getTabDepth("more", guideMemory)).toBe(1);
    expect(popTabDepth(backupMemory, "more").more.subRoute).toBeNull();
    expect(popTabDepth(aiToolsMemory, "more").more.subRoute).toBeNull();
    expect(popTabDepth(ocrSettingsMemory, "more").more.subRoute).toBeNull();
    expect(popTabDepth(guideMemory, "more").more.subRoute).toBeNull();
  });

  it("returns from the AI scope page to chat before leaving the AI workspace", () => {
    const memory = {
      ...createInitialTabMemory(),
      more: {
        ...createInitialTabMemory().more,
        subRoute: "ai" as const,
        aiScreen: "scope" as const,
      },
    };

    expect(getTabDepth("more", memory)).toBe(2);
    expect(buildTabPageKey("more", memory)).toBe(buildTabPageKey("more", {
      ...memory,
      more: { ...memory.more, aiScreen: "chat" as const },
    }));

    const chat = popTabDepth(memory, "more");
    expect(chat.more.subRoute).toBe("ai");
    expect(chat.more.aiScreen).toBe("chat");
    expect(getTabDepth("more", chat)).toBe(1);
    expect(popTabDepth(chat, "more").more.subRoute).toBeNull();
  });

  it("returns from podcast scope to editor and then to the podcast list", () => {
    const memory = {
      ...createInitialTabMemory(),
      more: {
        ...createInitialTabMemory().more,
        subRoute: "podcasts" as const,
        podcastId: "podcast-1",
        podcastScreen: "scope" as const,
      },
    };

    expect(getTabDepth("more", memory)).toBe(3);
    const editor = popTabDepth(memory, "more");
    expect(editor.more.podcastScreen).toBe("editor");
    expect(editor.more.podcastId).toBe("podcast-1");
    expect(getTabDepth("more", editor)).toBe(2);

    const list = popTabDepth(editor, "more");
    expect(list.more.podcastId).toBeUndefined();
    expect(list.more.podcastScreen).toBe("editor");
    expect(getTabDepth("more", list)).toBe(1);
  });
});
