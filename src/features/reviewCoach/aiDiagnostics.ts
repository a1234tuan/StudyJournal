import { AiRequestError, AiSchemaError } from "../../services/aiClientService";

export type ReviewCoachAiStage =
  | "feedback-interpretation"
  | "deep-planning"
  | "turn-generation"
  | "question-quality"
  | "answer-evaluation";

export type ReviewCoachAiFailureKind =
  | "invalid-json"
  | "schema-mismatch"
  | "insufficient-context"
  | "provider-request";

/**
 * Adds a safe role/stage label without persisting provider response text.
 * The original error remains available to tests and local UI formatting, while
 * batch errorCode continues to store only a stable category.
 */
export class ReviewCoachAiDiagnosticError extends Error {
  readonly name = "ReviewCoachAiDiagnosticError";

  constructor(
    readonly stage: ReviewCoachAiStage,
    readonly kind: ReviewCoachAiFailureKind,
    message: string,
    readonly billedPossible = true,
    readonly detail?: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export const diagnosticForAiError = (
  stage: ReviewCoachAiStage,
  error: unknown,
): ReviewCoachAiDiagnosticError => {
  if (error instanceof ReviewCoachAiDiagnosticError) return error;
  if (error instanceof AiSchemaError) {
    const kind: ReviewCoachAiFailureKind = /不是有效 JSON|不是 JSON/i.test(error.message) ? "invalid-json" : "schema-mismatch";
    return new ReviewCoachAiDiagnosticError(stage, kind, error.message, true, undefined, error);
  }
  if (error instanceof AiRequestError) {
    const kind: ReviewCoachAiFailureKind = error.message.startsWith("insufficient-context:")
      ? "insufficient-context"
      : "provider-request";
    return new ReviewCoachAiDiagnosticError(stage, kind, error.message, true, kind === "insufficient-context" ? error.message.slice("insufficient-context:".length) : undefined, error);
  }
  const kind: ReviewCoachAiFailureKind = "invalid-json";
  return new ReviewCoachAiDiagnosticError(stage, kind, error instanceof Error ? error.message : "AI response could not be parsed.", true, undefined, error);
};
