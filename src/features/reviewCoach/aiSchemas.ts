import { AiSchemaError } from "../../services/aiClientService";
import type {
  AdaptivePracticeType,
  FeedbackActionability,
  FeedbackDifficultyType,
  ImmediateAnswerAssessment,
} from "./domain";

export const REVIEW_COACH_AI_SCHEMA_VERSION = 1;
export const FEEDBACK_INTERPRETATION_PROMPT_VERSION = "feedback-interpretation-v1";
export const SESSION_BLUEPRINT_PROMPT_VERSION = "session-blueprint-v1";
export const QUIZ_TURN_PROMPT_VERSION = "quiz-turn-v2";
export const QUESTION_QUALITY_PROMPT_VERSION = "question-quality-v1";
export const ANSWER_EVALUATION_PROMPT_VERSION = "answer-evaluation-v1";
export const REVIEW_COACH_POLICY_VERSION = "review-coach-policy-v1";

export interface InsufficientContextAiResult {
  status: "insufficient-context";
  missingInformation: string[];
}

export interface FeedbackInterpretationAiResult {
  status: "ok";
  actionability: FeedbackActionability;
  difficultyType: FeedbackDifficultyType;
  stuckAt: string | null;
  userHypothesis: string | null;
  preferredPractice: string | null;
  missingInformation: string[];
  confidence: number;
}

export type FeedbackInterpretationAiResponse = FeedbackInterpretationAiResult | InsufficientContextAiResult;

export interface SessionBlueprintAiCandidate {
  mainDecisionBlockId: string;
  contentVersion: number;
  supportingDecisionBlockIds: string[];
  feedbackIds: string[];
  interpretationIds: string[];
  problemHypothesis: string;
  hypothesisConfidence: number;
  objective: string;
  completionCriteria: string[];
  initialPracticeType: AdaptivePracticeType;
  initialDifficulty: 1 | 2 | 3 | 4 | 5;
  expectedKeyPoints: string[];
  branches: Array<{
    when: "correct" | "partial" | "incorrect" | "skipped";
    nextStrategy: "continue" | "hint" | "explain" | "worked-example" | "prerequisite-check" | "finish";
  }>;
  allowedStrategies: Array<"continue" | "hint" | "explain" | "worked-example" | "prerequisite-check" | "finish">;
  forbiddenScope: string[];
  evidence: Array<{
    decisionBlockId: string;
    recordId: string;
    contentVersion: number;
    excerptHash: string;
    purpose: string;
  }>;
  maxTurns: number;
  maxRetriesPerTurn: number;
  maxEstimatedTokens: number;
}

export type SessionBlueprintAiResponse =
  | { status: "ok"; blueprints: SessionBlueprintAiCandidate[]; summary: string }
  | InsufficientContextAiResult;

export type QuizTurnAiResponse =
  | {
      status: "ok";
      practiceType: AdaptivePracticeType;
      answerMode: "open" | "objective" | "unique";
      question: string;
      answerCriteria: string[];
      sourceEvidence: SessionBlueprintAiCandidate["evidence"];
      hints: string[];
    }
  | InsufficientContextAiResult;

export type QuestionQualityAiResponse =
  | {
      status: "ok";
      verdict: "pass" | "fail";
      severeIssues: Array<"unsolvable" | "missing-condition" | "source-drift" | "non-unique-answer" | "answer-contradiction">;
      rationale: string;
    }
  | InsufficientContextAiResult;

export type AnswerEvaluationAiResponse =
  | {
      status: "ok";
      assessment: ImmediateAnswerAssessment;
      matchedCriteria: string[];
      missingCriteria: string[];
      rationale: string;
    }
  | InsufficientContextAiResult;

type JsonSchema = Readonly<Record<string, unknown>>;

const stringArraySchema = { type: "array", items: { type: "string" } } as const;
const insufficientContextBranch = {
  type: "object",
  additionalProperties: false,
  required: ["status", "missingInformation"],
  properties: {
    status: { const: "insufficient-context" },
    missingInformation: stringArraySchema,
  },
} as const;

const versionedEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decisionBlockId", "recordId", "contentVersion", "excerptHash", "purpose"],
  properties: {
    decisionBlockId: { type: "string", minLength: 1 },
    recordId: { type: "string", minLength: 1 },
    contentVersion: { type: "integer", minimum: 1 },
    excerptHash: { type: "string", minLength: 1 },
    purpose: { type: "string", minLength: 1 },
  },
} as const;

const practiceTypes: AdaptivePracticeType[] = [
  "concept-question",
  "calculation",
  "distinction",
  "cloze",
  "variation",
  "chunk-training",
  "prerequisite-check",
];

export const feedbackInterpretationJsonSchema: JsonSchema = {
  $id: `review-coach/feedback-interpretation/${REVIEW_COACH_AI_SCHEMA_VERSION}`,
  oneOf: [
    insufficientContextBranch,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "actionability", "difficultyType", "stuckAt", "userHypothesis", "preferredPractice", "missingInformation", "confidence"],
      properties: {
        status: { const: "ok" },
        actionability: { enum: ["needs_training", "reflection_only", "unclear"] },
        difficultyType: { enum: ["concept", "procedure", "confusion", "calculation", "application", "expression", "other"] },
        stuckAt: { type: ["string", "null"] },
        userHypothesis: { type: ["string", "null"] },
        preferredPractice: { type: ["string", "null"] },
        missingInformation: stringArraySchema,
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
  ],
};

export const sessionBlueprintJsonSchema: JsonSchema = {
  $id: `review-coach/session-blueprint/${REVIEW_COACH_AI_SCHEMA_VERSION}`,
  oneOf: [
    insufficientContextBranch,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "summary", "blueprints"],
      properties: {
        status: { const: "ok" },
        summary: { type: "string" },
        blueprints: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["mainDecisionBlockId", "contentVersion", "supportingDecisionBlockIds", "feedbackIds", "interpretationIds", "problemHypothesis", "hypothesisConfidence", "objective", "completionCriteria", "initialPracticeType", "initialDifficulty", "expectedKeyPoints", "branches", "allowedStrategies", "forbiddenScope", "evidence", "maxTurns", "maxRetriesPerTurn", "maxEstimatedTokens"],
            properties: {
              mainDecisionBlockId: { type: "string", minLength: 1 },
              contentVersion: { type: "integer", minimum: 1 },
              supportingDecisionBlockIds: stringArraySchema,
              feedbackIds: stringArraySchema,
              interpretationIds: stringArraySchema,
              problemHypothesis: { type: "string", minLength: 1 },
              hypothesisConfidence: { type: "number", minimum: 0, maximum: 1 },
              objective: { type: "string", minLength: 1 },
              completionCriteria: { ...stringArraySchema, minItems: 1 },
              initialPracticeType: { enum: practiceTypes },
              initialDifficulty: { type: "integer", minimum: 1, maximum: 5 },
              expectedKeyPoints: { ...stringArraySchema, minItems: 1 },
              branches: {
                type: "array",
                minItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["when", "nextStrategy"],
                  properties: {
                    when: { enum: ["correct", "partial", "incorrect", "skipped"] },
                    nextStrategy: { enum: ["continue", "hint", "explain", "worked-example", "prerequisite-check", "finish"] },
                  },
                },
              },
              allowedStrategies: { type: "array", items: { enum: ["continue", "hint", "explain", "worked-example", "prerequisite-check", "finish"] } },
              forbiddenScope: stringArraySchema,
              evidence: { type: "array", minItems: 1, items: versionedEvidenceSchema },
              maxTurns: { type: "integer", minimum: 1, maximum: 20 },
              maxRetriesPerTurn: { type: "integer", minimum: 0, maximum: 2 },
              maxEstimatedTokens: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
  ],
};

export const quizTurnJsonSchema: JsonSchema = {
  $id: `review-coach/quiz-turn/${REVIEW_COACH_AI_SCHEMA_VERSION}`,
  oneOf: [
    insufficientContextBranch,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "practiceType", "answerMode", "question", "answerCriteria", "sourceEvidence", "hints"],
      properties: {
        status: { const: "ok" },
        practiceType: { enum: practiceTypes },
        answerMode: { enum: ["open", "objective", "unique"] },
        question: { type: "string", minLength: 1 },
        answerCriteria: { ...stringArraySchema, minItems: 1 },
        sourceEvidence: { type: "array", minItems: 1, items: versionedEvidenceSchema },
        hints: stringArraySchema,
      },
    },
  ],
};

export const questionQualityJsonSchema: JsonSchema = {
  $id: `review-coach/question-quality/${REVIEW_COACH_AI_SCHEMA_VERSION}`,
  oneOf: [
    insufficientContextBranch,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "verdict", "severeIssues", "rationale"],
      properties: {
        status: { const: "ok" },
        verdict: { enum: ["pass", "fail"] },
        severeIssues: { type: "array", items: { enum: ["unsolvable", "missing-condition", "source-drift", "non-unique-answer", "answer-contradiction"] } },
        rationale: { type: "string" },
      },
    },
  ],
};

export const answerEvaluationJsonSchema: JsonSchema = {
  $id: `review-coach/answer-evaluation/${REVIEW_COACH_AI_SCHEMA_VERSION}`,
  oneOf: [
    insufficientContextBranch,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "assessment", "matchedCriteria", "missingCriteria", "rationale"],
      properties: {
        status: { const: "ok" },
        assessment: { enum: ["correct", "partial", "incorrect", "unreliable"] },
        matchedCriteria: stringArraySchema,
        missingCriteria: stringArraySchema,
        rationale: { type: "string" },
      },
    },
  ],
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isConfidence = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const assertExactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string) => {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new AiSchemaError(`Invalid ${label} response: unexpected field.`);
};

export const isInsufficientContextAiResult = (value: unknown): value is InsufficientContextAiResult =>
  isObject(value) && value.status === "insufficient-context" && isStringArray(value.missingInformation);

export const parseFeedbackInterpretationAiResponse = (value: unknown): FeedbackInterpretationAiResponse => {
  if (isInsufficientContextAiResult(value)) {
    assertExactKeys(value as unknown as Record<string, unknown>, ["status", "missingInformation"], "feedback interpretation");
    return value;
  }
  if (!isObject(value) || value.status !== "ok") throw new AiSchemaError("Invalid feedback interpretation response status.");
  assertExactKeys(value, ["status", "actionability", "difficultyType", "stuckAt", "userHypothesis", "preferredPractice", "missingInformation", "confidence"], "feedback interpretation");
  if (!["needs_training", "reflection_only", "unclear"].includes(String(value.actionability))) throw new AiSchemaError("Invalid feedback actionability.");
  if (!["concept", "procedure", "confusion", "calculation", "application", "expression", "other"].includes(String(value.difficultyType))) throw new AiSchemaError("Invalid feedback difficulty type.");
  if ((value.stuckAt !== null && typeof value.stuckAt !== "string") ||
      (value.userHypothesis !== null && typeof value.userHypothesis !== "string") ||
      (value.preferredPractice !== null && typeof value.preferredPractice !== "string") ||
      !isStringArray(value.missingInformation) || !isConfidence(value.confidence)) {
    throw new AiSchemaError("Invalid feedback interpretation response body.");
  }
  return value as unknown as FeedbackInterpretationAiResult;
};

const requireOkObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!isObject(value) || value.status !== "ok") throw new AiSchemaError(`Invalid ${label} response status.`);
  return value;
};

const requireString = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim()) throw new AiSchemaError(`Invalid ${label}.`);
};

const isPracticeType = (value: unknown): value is AdaptivePracticeType =>
  typeof value === "string" && practiceTypes.includes(value as AdaptivePracticeType);

const validateEvidence = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) =>
    !isObject(item) ||
    typeof item.decisionBlockId !== "string" ||
    typeof item.recordId !== "string" ||
    !Number.isSafeInteger(item.contentVersion) || Number(item.contentVersion) < 1 ||
    typeof item.excerptHash !== "string" ||
    typeof item.purpose !== "string"
  )) throw new AiSchemaError("Invalid source evidence.");
  for (const item of value as Array<Record<string, unknown>>) {
    assertExactKeys(item, ["decisionBlockId", "recordId", "contentVersion", "excerptHash", "purpose"], "source evidence");
  }
};

export const parseSessionBlueprintAiResponse = (value: unknown): SessionBlueprintAiResponse => {
  if (isInsufficientContextAiResult(value)) {
    assertExactKeys(value as unknown as Record<string, unknown>, ["status", "missingInformation"], "session blueprint");
    return value;
  }
  const body = requireOkObject(value, "session blueprint");
  assertExactKeys(body, ["status", "summary", "blueprints"], "session blueprint");
  if (typeof body.summary !== "string" || !Array.isArray(body.blueprints) || body.blueprints.length < 1 || body.blueprints.length > 3) {
    throw new AiSchemaError("Invalid session blueprint response body.");
  }
  for (const candidate of body.blueprints) {
    if (!isObject(candidate)) throw new AiSchemaError("Invalid session blueprint candidate.");
    assertExactKeys(candidate, ["mainDecisionBlockId", "contentVersion", "supportingDecisionBlockIds", "feedbackIds", "interpretationIds", "problemHypothesis", "hypothesisConfidence", "objective", "completionCriteria", "initialPracticeType", "initialDifficulty", "expectedKeyPoints", "branches", "allowedStrategies", "forbiddenScope", "evidence", "maxTurns", "maxRetriesPerTurn", "maxEstimatedTokens"], "session blueprint candidate");
    requireString(candidate.mainDecisionBlockId, "mainDecisionBlockId");
    requireString(candidate.problemHypothesis, "problemHypothesis");
    requireString(candidate.objective, "objective");
    if (!Number.isSafeInteger(candidate.contentVersion) || Number(candidate.contentVersion) < 1 ||
        !isConfidence(candidate.hypothesisConfidence) ||
        !isPracticeType(candidate.initialPracticeType) ||
        !Number.isSafeInteger(candidate.initialDifficulty) || Number(candidate.initialDifficulty) < 1 || Number(candidate.initialDifficulty) > 5 ||
        !isStringArray(candidate.supportingDecisionBlockIds) || !isStringArray(candidate.feedbackIds) || !isStringArray(candidate.interpretationIds) ||
        !isStringArray(candidate.completionCriteria) || candidate.completionCriteria.length === 0 ||
        !isStringArray(candidate.expectedKeyPoints) || candidate.expectedKeyPoints.length === 0 ||
        !isStringArray(candidate.allowedStrategies) || !isStringArray(candidate.forbiddenScope) ||
        !Array.isArray(candidate.branches) || candidate.branches.length < 4 ||
        !Number.isSafeInteger(candidate.maxTurns) || Number(candidate.maxTurns) < 1 || Number(candidate.maxTurns) > 20 ||
        !Number.isSafeInteger(candidate.maxRetriesPerTurn) || Number(candidate.maxRetriesPerTurn) < 0 || Number(candidate.maxRetriesPerTurn) > 2 ||
        !Number.isSafeInteger(candidate.maxEstimatedTokens) || Number(candidate.maxEstimatedTokens) < 1) {
      throw new AiSchemaError("Invalid session blueprint candidate fields.");
    }
    const allowedBranches = new Set(["continue", "hint", "explain", "worked-example", "prerequisite-check", "finish"]);
    const cases = new Set<string>();
    for (const branch of candidate.branches) {
      if (!isObject(branch) || !["correct", "partial", "incorrect", "skipped"].includes(String(branch.when)) || !allowedBranches.has(String(branch.nextStrategy))) {
        throw new AiSchemaError("Invalid session blueprint branch.");
      }
      assertExactKeys(branch, ["when", "nextStrategy"], "session blueprint branch");
      cases.add(String(branch.when));
    }
    if (["correct", "partial", "incorrect", "skipped"].some((branch) => !cases.has(branch)) || candidate.allowedStrategies.some((strategy) => !allowedBranches.has(strategy))) {
      throw new AiSchemaError("Incomplete or unsupported session blueprint branches.");
    }
    validateEvidence(candidate.evidence);
  }
  return body as unknown as SessionBlueprintAiResponse;
};

export const parseQuizTurnAiResponse = (value: unknown): QuizTurnAiResponse => {
  if (isInsufficientContextAiResult(value)) {
    assertExactKeys(value as unknown as Record<string, unknown>, ["status", "missingInformation"], "quiz turn");
    return value;
  }
  const body = requireOkObject(value, "quiz turn");
  assertExactKeys(body, ["status", "practiceType", "answerMode", "question", "answerCriteria", "sourceEvidence", "hints"], "quiz turn");
  requireString(body.question, "question");
  if (!isPracticeType(body.practiceType) || !["open", "objective", "unique"].includes(String(body.answerMode)) || !isStringArray(body.answerCriteria) || body.answerCriteria.length === 0 || !isStringArray(body.hints)) {
    throw new AiSchemaError("Invalid quiz turn response body.");
  }
  validateEvidence(body.sourceEvidence);
  return body as unknown as QuizTurnAiResponse;
};

export const parseQuestionQualityAiResponse = (value: unknown): QuestionQualityAiResponse => {
  if (isInsufficientContextAiResult(value)) {
    assertExactKeys(value as unknown as Record<string, unknown>, ["status", "missingInformation"], "question quality");
    return value;
  }
  const body = requireOkObject(value, "question quality");
  assertExactKeys(body, ["status", "verdict", "severeIssues", "rationale"], "question quality");
  const issues = ["unsolvable", "missing-condition", "source-drift", "non-unique-answer", "answer-contradiction"];
  if (!["pass", "fail"].includes(String(body.verdict)) || !isStringArray(body.severeIssues) || body.severeIssues.some((item) => !issues.includes(item)) || typeof body.rationale !== "string") {
    throw new AiSchemaError("Invalid question quality response body.");
  }
  return body as unknown as QuestionQualityAiResponse;
};

export const parseAnswerEvaluationAiResponse = (value: unknown): AnswerEvaluationAiResponse => {
  if (isInsufficientContextAiResult(value)) {
    assertExactKeys(value as unknown as Record<string, unknown>, ["status", "missingInformation"], "answer evaluation");
    return value;
  }
  const body = requireOkObject(value, "answer evaluation");
  assertExactKeys(body, ["status", "assessment", "matchedCriteria", "missingCriteria", "rationale"], "answer evaluation");
  if (!["correct", "partial", "incorrect", "unreliable"].includes(String(body.assessment)) ||
      !isStringArray(body.matchedCriteria) || !isStringArray(body.missingCriteria) || typeof body.rationale !== "string") {
    throw new AiSchemaError("Invalid answer evaluation response body.");
  }
  return body as unknown as AnswerEvaluationAiResponse;
};

export const REVIEW_COACH_AI_CONTRACTS = {
  feedbackInterpretation: {
    promptVersion: FEEDBACK_INTERPRETATION_PROMPT_VERSION,
    policyVersion: REVIEW_COACH_POLICY_VERSION,
    schemaVersion: REVIEW_COACH_AI_SCHEMA_VERSION,
    schema: feedbackInterpretationJsonSchema,
  },
  sessionBlueprint: {
    promptVersion: SESSION_BLUEPRINT_PROMPT_VERSION,
    policyVersion: REVIEW_COACH_POLICY_VERSION,
    schemaVersion: REVIEW_COACH_AI_SCHEMA_VERSION,
    schema: sessionBlueprintJsonSchema,
  },
  quizTurn: {
    promptVersion: QUIZ_TURN_PROMPT_VERSION,
    policyVersion: REVIEW_COACH_POLICY_VERSION,
    schemaVersion: REVIEW_COACH_AI_SCHEMA_VERSION,
    schema: quizTurnJsonSchema,
  },
  questionQuality: {
    promptVersion: QUESTION_QUALITY_PROMPT_VERSION,
    policyVersion: REVIEW_COACH_POLICY_VERSION,
    schemaVersion: REVIEW_COACH_AI_SCHEMA_VERSION,
    schema: questionQualityJsonSchema,
  },
  answerEvaluation: {
    promptVersion: ANSWER_EVALUATION_PROMPT_VERSION,
    policyVersion: REVIEW_COACH_POLICY_VERSION,
    schemaVersion: REVIEW_COACH_AI_SCHEMA_VERSION,
    schema: answerEvaluationJsonSchema,
  },
} as const;
