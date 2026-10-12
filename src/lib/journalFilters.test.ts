import { describe, expect, it } from "vitest";
import type { RecordBlock } from "../types";
import { filterJournalRecords, journalTags, restoreJournalScope, type JournalTopic } from "./journalFilters";

const record = (id: string, subject: string, tags: string[], deletedAt?: string): RecordBlock => ({ id, subject, tags, deletedAt, type: "record", date: "2026-10-12", createdAt: "2026-10-12", updatedAt: "2026-10-12", order: 0, title: id, contentHtml: "", assets: [], formulas: [], mistakeRefs: [] });
const records = [record("math", "数学", [" 重点 ", "Apple", "积分"]), record("network", "计网", ["重点", "apple", "错题"]), record("gone", "数学", ["删除专用"], "2026-10-12")];
const topic: JournalTopic = { owner: "deviceGuest", libraryId: "library", libraryTitle: "库", workspaceId: "topic", title: "专题", recordIds: new Set(["math", "gone"]) };

describe("journal filters", () => {
  it("collects cross-subject canonical tags in pinyin order without deleted records", () => {
    expect(journalTags(records).map(tag => tag.label)).toEqual(["错题", "积分", "重点", "Apple"]);
  });
  it("intersects every scope with subject and never duplicates records", () => {
    expect(filterJournalRecords(records, "全部", { kind: "all" }, []).map(item => item.id)).toEqual(["math", "network"]);
    expect(filterJournalRecords(records, "计网", { kind: "all" }, []).map(item => item.id)).toEqual(["network"]);
    expect(filterJournalRecords(records, "全部", { kind: "tag", tag: "重点" }, [])).toHaveLength(2);
    expect(filterJournalRecords(records, "数学", { kind: "tag", tag: "APPLE" }, []).map(item => item.id)).toEqual(["math"]);
    const scope = { kind: "topic" as const, owner: topic.owner, libraryId: topic.libraryId, workspaceId: topic.workspaceId };
    expect(filterJournalRecords(records, "全部", scope, [topic]).map(item => item.id)).toEqual(["math"]);
    expect(filterJournalRecords(records, "计网", scope, [topic])).toEqual([]);
    expect(filterJournalRecords(records, "全部", { ...scope, owner: "account:other" }, [topic])).toEqual([]);
    expect(filterJournalRecords(records, "全部", scope, [])).toEqual([]);
  });
  it("normalizes history and fails invalid scopes back to all", () => {
    expect(restoreJournalScope({ kind: "tag", tag: " APPLE " })).toEqual({ kind: "tag", tag: "apple" });
    expect(restoreJournalScope({ kind: "topic", owner: "account:", libraryId: "lib", workspaceId: "topic" })).toEqual({ kind: "all" });
    expect(restoreJournalScope(undefined)).toEqual({ kind: "all" });
  });
});
