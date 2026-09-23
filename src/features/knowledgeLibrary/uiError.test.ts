import { describe, expect, it } from "vitest";
import { KnowledgeError } from "./domain";
import { knowledgeDiagnostics, knowledgeUiError } from "./uiError";

describe("knowledge error feedback", () => {
  it.each([
    ["permission-denied", "权限"], ["unauthenticated", "重新登录"], ["unavailable", "网络"],
    ["deadline-exceeded", "核对提交结果"], ["resource-exhausted", "额度"], ["failed-precondition", "配置"],
  ])("classifies %s without disclosing provider text", (code, expected) => {
    const result = knowledgeUiError({ code: "firestore/" + code, message: "secret-key-user-content" }, "连接账号库");
    expect(result.message).toContain(expected);
    expect(result.message).toContain("本机内容保留");
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(knowledgeDiagnostics()).toContainEqual(result);
  });
  it("retains actionable stale-write guidance and hides unknown detail", () => {
    expect(knowledgeUiError(new KnowledgeError("stale", "private data")).message).toContain("输入仍保留");
    const result = knowledgeUiError(new Error("credentials and record body"));
    expect(result.category).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("credentials");
  });
  it("bounds diagnostics to twenty sanitized entries", () => {
    for (let index = 0; index < 30; index += 1) knowledgeUiError({ code: "unavailable", token: "secret" });
    expect(knowledgeDiagnostics()).toHaveLength(20);
    expect(JSON.stringify(knowledgeDiagnostics())).not.toContain("secret");
  });
});
