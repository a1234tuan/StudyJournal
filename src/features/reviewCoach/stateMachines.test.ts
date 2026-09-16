import { describe, expect, it } from "vitest";

import {
  ReviewCoachTransitionError,
  transitionAdaptiveQuizTurn,
  transitionAdaptiveReviewTask,
  transitionAnalysisBatch,
  transitionAnalysisQueueItem,
  transitionDelayedVerification,
  transitionFeedbackInterpretation,
  transitionFeedbackStatus,
} from "./stateMachines";

describe("review coach state machines", () => {
  it("accepts legal progress and retry transitions", () => {
    expect(transitionFeedbackInterpretation("pending", "running")).toBe("running");
    expect(transitionFeedbackInterpretation("failed", "pending")).toBe("pending");
    expect(transitionAnalysisQueueItem("eligible", "batched")).toBe("batched");
    expect(transitionAnalysisBatch("confirmed", "running")).toBe("running");
    expect(transitionAdaptiveReviewTask("waiting", "current")).toBe("current");
    expect(transitionAdaptiveReviewTask("in-progress", "deferred")).toBe("deferred");
    expect(transitionAdaptiveQuizTurn("displayed", "answered")).toBe("answered");
    expect(transitionDelayedVerification("scheduled", "eligible")).toBe("eligible");
    expect(transitionFeedbackStatus("active", "deleted")).toBe("deleted");
  });

  it("rejects transitions that would rewrite terminal facts", () => {
    expect(() => transitionFeedbackInterpretation("succeeded", "running")).toThrow(ReviewCoachTransitionError);
    expect(transitionAnalysisQueueItem("consumed", "eligible")).toBe("eligible");
    expect(() => transitionAnalysisBatch("succeeded", "running")).toThrow(ReviewCoachTransitionError);
    expect(() => transitionAdaptiveReviewTask("completed", "in-progress")).toThrow(ReviewCoachTransitionError);
    expect(() => transitionAdaptiveQuizTurn("answered", "displayed")).toThrow(ReviewCoachTransitionError);
    expect(() => transitionDelayedVerification("completed", "eligible")).toThrow(ReviewCoachTransitionError);
    expect(() => transitionFeedbackStatus("deleted", "active")).toThrow(ReviewCoachTransitionError);
  });
});
