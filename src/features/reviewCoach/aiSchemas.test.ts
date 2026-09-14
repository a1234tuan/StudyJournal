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
  // Bumping any of these is a deliberate act: `promptVersion` is recorded on blueprints and
  // turns, and feeds effect attribution, so an unannounced change would silently pool
  // results produced under different instructions.
  const EXPECTED_PROMPT_VERSIONS: Record<string, string> = {
    feedbackInterpretation: "feedback-interpretation-v1",
    sessionBlueprint: "session-blueprint-v1",
    quizTurn: "quiz-turn-v2",
    questionQuality: "question-quality-v1",
    answerEvaluation: "answer-evaluation-v2",
  };

  it("pins prompt, policy, and JSON schema versions for every AI role", () => {
    for (const [role, contract] of Object.entries(REVIEW_COACH_AI_CONTRACTS)) {
      expect(contract.promptVersion).toBe(EXPECTED_PROMPT_VERSIONS[role]);
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
