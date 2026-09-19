import { describe, expect, it } from "vitest";

import { AiRequestError, AiSchemaError } from "../../services/aiClientService";
import type { AnalysisBatch } from "./domain";
import { actionableAnalysisBatchError, actionableDirectAnalysisError, analysisFailureCode, assertAnalysisBatchCompleted } from "./analysisErrors";
import { ReviewCoachValidationError } from "./validation";
import { diagnosticForAiError } from "./aiDiagnostics";

const batch = (status: AnalysisBatch["status"], errorCode: string): AnalysisBatch => ({
  id: "batch-1",
  status,
  inputRefs: [],
  subBatches: [{ id: "sub-1", inputRefs: [], status: "failed", errorCode }],
  provider: "Gemini relay",
  model: "gemini-3.1-pro",
  promptVersion: "p",
  policyVersion: "policy",
  schemaVersion: 1,
  inputFingerprint: "fingerprint",
  idempotencyKey: "analysis:1",
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z",
});

describe("learning coach analysis errors", () => {
  it("persists a stable category instead of a raw provider response", () => {
    const raw = "provider rejected secret-looking payload at https://relay.example";
    const code = analysisFailureCode(new AiRequestError(raw, false, undefined, false, undefined, "schema"));

    expect(code).toBe("analysis:incompatible-response");
    expect(code).not.toContain(raw);
    expect(code).not.toContain("relay.example");
  });

  it("turns a failed batch into a readable model compatibility error", () => {
    const error = actionableAnalysisBatchError(batch("failed", "analysis:incompatible-response"));

    expect(error?.message).toContain("没有生成复习任务");
    expect(error?.message).toContain("Gemini relay / gemini-3.1-pro");
    expect(error?.message).toContain("结构化 JSON");
    expect(error?.message).not.toMatch(/诊断编号|AR-/);
  });

  it("throws instead of letting a failed batch reach the UI success path", () => {
    expect(() => assertAnalysisBatchCompleted(batch("failed", "analysis:network"))).toThrow(/没有生成复习任务.*无法连接/);
    expect(() => assertAnalysisBatchCompleted(batch("succeeded", "analysis:unknown"))).not.toThrow();
  });

  it("classifies invalid blueprint output as an incompatible model response", () => {
    expect(analysisFailureCode(new Error("Blueprint main decision block is missing, duplicated, or stale.")))
      .toBe("analysis:incompatible-response");
  });

  it("persists a stage-specific code for invalid JSON without persisting the response", () => {
    const raw = "```json\n{not-json with secret relay payload}\n```";
    const diagnostic = diagnosticForAiError("deep-planning", new AiSchemaError("快速模型返回的内容不是有效 JSON。"));
    const code = analysisFailureCode(diagnostic);

    expect(code).toBe("analysis:deep-planning:invalid-json");
    expect(code).not.toContain(raw);
    expect(actionableAnalysisBatchError(batch("failed", code))?.message)
      .toContain("深度规划阶段：模型服务已返回内容，但内容不是有效 JSON");
  });

  it("keeps schema mismatch and provider failures distinguishable by stage", () => {
    const schemaCode = analysisFailureCode(diagnosticForAiError(
      "turn-generation",
      new AiSchemaError("题目字段不符合 Schema。"),
    ));
    const providerCode = analysisFailureCode(diagnosticForAiError(
      "question-quality",
      new AiRequestError("relay returned an unsupported response", false, undefined, false, undefined, "schema"),
    ));

    expect(schemaCode).toBe("analysis:turn-generation:schema-mismatch");
    expect(providerCode).toBe("analysis:question-quality:incompatible-response");
    expect(actionableAnalysisBatchError(batch("failed", schemaCode))?.message)
      .toContain("字段不符合");
  });

  it("turns a directly thrown local consistency error into a readable recovery step", () => {
    const error = actionableDirectAnalysisError(
      new ReviewCoachValidationError("changed-analysis-input", "sensitive internal detail"),
      { providerName: "DeepSeek", model: "deepseek-v4-flash" },
    );

    expect(error.message).toContain("冻结输入发生了变化");
    expect(error.message).toContain("RC-changed-analysis-input");
    expect(error.message).not.toContain("sensitive internal detail");
  });

  it("distinguishes an occupied queue item from a duplicate open task", () => {
    const queueError = actionableDirectAnalysisError(
      new ReviewCoachValidationError("invalid-analysis-input", "internal queue id"),
    );
    const taskError = actionableDirectAnalysisError(
      new ReviewCoachValidationError("task-uniqueness", "internal task id"),
    );

    expect(queueError.message).toContain("另一次点击、恢复操作或同步接管");
    expect(queueError.message).toContain("RC-invalid-analysis-input");
    expect(taskError.message).toContain("已经有一个未完成的学习助教任务");
    expect(taskError.message).toContain("RC-task-uniqueness");
  });

  it("reports partial completion without discarding the tasks that succeeded", () => {
    const error = actionableAnalysisBatchError(batch("partial", "analysis:timeout"));

    expect(error?.message).toContain("部分复习重点已生成任务");
    expect(error?.message).toContain("限定时间内没有返回");
  });

  it("classifies legacy raw codes but never echoes them", () => {
    const legacy = "HTTP 401 invalid API key: do-not-display-this";
    const error = actionableAnalysisBatchError(batch("failed", legacy));

    expect(error?.message).toContain("认证失败");
    expect(error?.message).not.toContain("do-not-display-this");
  });
});
