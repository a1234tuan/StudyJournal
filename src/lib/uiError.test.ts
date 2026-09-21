import { describe, expect, it } from "vitest";

import { formatUiError, normalizeUiError, StaleRecordError } from "./uiError";

describe("uiError", () => {
  it("renders only the authored stale-record guidance without trusting mutable messages", () => {
    const error = new StaleRecordError();
    error.message = "secret-token";
    expect(formatUiError(error, "record-save")).toContain("正式内容已更新");
    expect(formatUiError(error, "record-save")).not.toContain("secret-token");
    expect(formatUiError(new Error("正式内容已更新 secret-token"), "record-save")).not.toContain("secret-token");
    expect(formatUiError(error, "record-draft-save")).toContain("请勿关闭页面");
    expect(formatUiError(error, "record-draft-save")).not.toContain("已存于本机草稿");
  });
  it("never exposes a raw IndexedDB error to the user", () => {
    const raw = new Error("DexieError QuotaExceeded records secret-token prompt-body");
    const result = formatUiError(raw, "review-rating");

    expect(result).toContain("复习评分失败");
    expect(result).toContain("诊断编号");
    expect(result).not.toContain("Dexie");
    expect(result).not.toContain("secret-token");
    expect(result).not.toContain("prompt-body");
  });

  it("uses context-specific recovery copy and a short diagnostic id", () => {
    const result = normalizeUiError(new DOMException("database closed", "InvalidStateError"), "record-save");

    expect(result.message).toContain("本机草稿");
    expect(result.diagnosticId).toMatch(/^RS-[A-Z0-9]{8}$/);
  });
});
