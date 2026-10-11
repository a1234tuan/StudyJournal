import type { ReviewMarkEvent, ReviewMarkValue } from "./domain";
export const markTestStamp = "2026-10-11T00:00:00.000Z";
export const markTestValue: ReviewMarkValue = { kind: "highlight", color: "amber", label: "易混", anchor: { quote: "需要巩固", prefix: "这里", suffix: "的内容", blockText: "这里需要巩固的内容" } };
export const markTestEvent = (id = "mark-event", parents: string[] = [], value: ReviewMarkValue | null = markTestValue): ReviewMarkEvent => ({ id, recordId: "mark-record", markId: "mark", parents, value, createdAt: markTestStamp, updatedAt: markTestStamp });

export const structuredMarkTestValue: ReviewMarkValue = { ...markTestValue, anchor: { quote: "$x^2$", blockText: JSON.stringify({ kind: "content", parts: [["block-formula", "x^2"]] }), prefix: "", suffix: "", structured: { version: 1, target: "formula", start: 0, end: 1, before: "", after: "" } } };
