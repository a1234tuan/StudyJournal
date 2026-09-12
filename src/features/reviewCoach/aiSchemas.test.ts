import { describe, expect, it } from "vitest";

import {
  REVIEW_COACH_AI_CONTRACTS,
  parseFeedbackInterpretationAiResponse,
  parseSessionBlueprintAiResponse,
  parseQuizTurnAiResponse,
  parseQuestionQualityAiResponse,
  parseAnswerEvaluationAiResponse,
} from "./aiSchemas";

describe("review coach AI contracts", () => {
  it("pins prompt, policy, and JSON schema versions for every AI role", () => {
    for (const contract of Object.values(REVIEW_COACH_AI_CONTRACTS)) {
      expect(contract.promptVersion).toMatch(contract.promptVersion === "quiz-turn-v2" ? /-v2$/ : /-v1$/);
      expect(contract.policyVersion).toBe("review-coach-policy-v1");
      expect(contract.schemaVersion).toBe(1);
      expect(contract.schema).toHaveProperty("oneOf");
      expect(JSON.stringify(contract.schema)).toContain("insufficient-context");
    }
  });

  it("accepts an explicit insufficient-context result", () => {
    expect(parseFeedbackInterpretationAiResponse({
      status: "insufficient-context",
      missingInformation: ["missing OCR"],
    })).toEqual({ status: "insufficient-context", missingInformation: ["missing OCR"] });
  });

  it("rejects invented or malformed interpretation output", () => {
    expect(() => parseFeedbackInterpretationAiResponse({
      status: "ok",
      actionability: "do-anything",
      difficultyType: "concept",
      stuckAt: null,
      userHypothesis: null,
      preferredPractice: null,
      missingInformation: [],
      confidence: 2,
    })).toThrow();
    expect(() => parseFeedbackInterpretationAiResponse({
      status: "ok",
      actionability: "needs_training",
      difficultyType: "concept",
      missingInformation: [],
      confidence: 0.7,
    })).toThrow();
  });

  it("rejects extra fields in a session blueprint", () => {
    expect(() => parseSessionBlueprintAiResponse({
      status: "insufficient-context",
      missingInformation: ["source"],
      unexpected: true,
    })).toThrow("unexpected field");
  });

  it("validates Stage 6 turn, quality, and answer contracts strictly", () => {
    const evidence = [{ decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, excerptHash: "hash-1", purpose: "source" }];
    expect(parseQuizTurnAiResponse({ status: "ok", practiceType: "variation", answerMode: "open", question: "Explain.", answerCriteria: ["criterion"], sourceEvidence: evidence, hints: ["Recall the boundary."] })).toMatchObject({ answerMode: "open" });
    expect(parseQuestionQualityAiResponse({ status: "ok", verdict: "pass", severeIssues: [], rationale: "source aligned" })).toMatchObject({ verdict: "pass" });
    expect(parseAnswerEvaluationAiResponse({ status: "ok", assessment: "partial", matchedCriteria: ["criterion"], missingCriteria: [], rationale: "partial" })).toMatchObject({ assessment: "partial" });
    expect(() => parseQuizTurnAiResponse({ status: "ok", practiceType: "variation", answerMode: "open", question: "Explain.", answerCriteria: ["criterion"], sourceEvidence: evidence, hints: [], extra: true })).toThrow("unexpected field");
  });
});
