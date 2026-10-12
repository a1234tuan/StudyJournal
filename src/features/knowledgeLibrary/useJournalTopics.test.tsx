import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { JournalTopic } from "../../lib/journalFilters";
import { useJournalTopics } from "./useJournalTopics";

const state = vi.hoisted(() => ({ owner: "deviceGuest", generation: 0, subscriptions: [] as Array<{ next: (topics: JournalTopic[]) => void; error: () => void }>, unsubscribe: vi.fn() }));
vi.mock("dexie", () => ({ liveQuery: () => ({ subscribe: (callbacks: typeof state.subscriptions[number]) => { state.subscriptions.push(callbacks); return { unsubscribe: state.unsubscribe }; } }) }));
vi.mock("./runtime", () => ({ knowledgeRepository: {} }));
vi.mock("./journalTopics", () => ({ loadJournalTopics: vi.fn() }));
vi.mock("./context", () => ({ currentKnowledgeOwner: () => state.owner, knowledgeContextGeneration: () => state.generation }));
beforeEach(() => { state.owner = "deviceGuest"; state.generation = 0; state.subscriptions = []; state.unsubscribe.mockClear(); });
const topic: JournalTopic = { owner: "deviceGuest", libraryId: "library", libraryTitle: "库", workspaceId: "topic", title: "专题", recordIds: new Set(["record"]) };

it("clears old-owner results and ignores in-flight callbacks after owner changes", () => {
  const { result } = renderHook(useJournalTopics);
  const old = state.subscriptions[0];
  act(() => old.next([topic]));
  expect(result.current.topics).toEqual([topic]);
  act(() => { state.owner = "account:other"; state.generation = 1; window.dispatchEvent(new Event("knowledge-owner-changed")); });
  expect(result.current.topics).toEqual([]);
  expect(result.current.loading).toBe(true);
  act(() => old.next([topic]));
  expect(result.current.topics).toEqual([]);
  act(() => state.subscriptions.at(-1)!.next([]));
  expect(result.current.loading).toBe(false);
  expect(result.current.owner).toBe("account:other");
});

it("distinguishes failures from empty topics and retries with a fresh subscription", () => {
  const { result, unmount } = renderHook(useJournalTopics);
  act(() => state.subscriptions[0].error());
  expect(result.current.error).toContain("专题读取失败");
  expect(result.current.loading).toBe(false);
  act(() => result.current.retry());
  expect(result.current.loading).toBe(true);
  expect(state.subscriptions).toHaveLength(2);
  act(() => state.subscriptions[1].next([topic]));
  expect(result.current.error).toBe("");
  expect(result.current.topics).toHaveLength(1);
  unmount();
  expect(state.unsubscribe).toHaveBeenCalledTimes(2);
});
