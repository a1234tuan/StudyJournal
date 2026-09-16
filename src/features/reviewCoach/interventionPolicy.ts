import type { InterventionPath, TaskOutcomeEvent } from "./domain";
import { consecutiveExecutionFailedCount } from "./evidencePolicy";

/**
 * M3: the three learning action paths.
 *
 * The learner says which *action* they need next - "I could not form it",
 * "I mixed it up", "I could have but did not produce it" - and the system
 * picks the follow-up work. The learner never confirms a diagnosis; the words
 * they choose are an intent, and the mapping from intent to work is a fixed
 * rule the system owns.
 *
 * There are exactly three options. A fourth ("I'm not sure") would push the
 * classification back onto the learner, which is precisely the judgment the
 * design says they cannot reliably make.
 */

export interface InterventionAction {
  path: InterventionPath;
  /** Short label the learner reads. States the action, not a diagnosis. */
  label: string;
  /** What the next retrieval is asked to do. */
  nextStrategy: InterventionStrategy;
  /**
   * The blueprint-branch strategy that best expresses this action.
   *
   * `nextStrategy` and a blueprint branch's `nextStrategy` are two different
   * vocabularies and must not be conflated: the branch strategy is authored by
   * the model and runs the `allowedStrategies` regime (hint tiers, worked
   * examples, prerequisites), while `nextStrategy` above is the system-owned
   * pedagogical action. This field is the bridge, so a learner's chosen action
   * can steer generation without pretending to be a regime decision the model
   * never made.
   */
  branchStrategy: "continue" | "hint" | "explain" | "worked-example" | "prerequisite-check" | "finish";
  /** One line shown with the buttons, so the choice is not a guess. */
  hint: string;
}

/** The system-owned pedagogical action vocabulary. */
export type InterventionStrategy = "rebuild" | "discriminate" | "produce";

/**
 * Fixed mapping from learner intent to next retrieval strategy.
 *
 * - `not-formed` - there was nothing to retrieve. Go back to the material and
 *   rebuild the rule from the source, then re-retrieve in the target form.
 * - `confused` - something came back, but it was the wrong something. Put the
 *   two candidates side by side and force a discriminating retrieval.
 * - `execution-failed` - the knowledge is there but the production failed.
 *   The next retrieval exercises production, not recognition.
 */
export const INTERVENTION_ACTIONS: readonly InterventionAction[] = [
  { path: "not-formed", label: "我没有想出来", hint: "回到材料重建这条规则，然后重新提取", nextStrategy: "rebuild", branchStrategy: "prerequisite-check" },
  { path: "confused", label: "我记混了", hint: "把两条容易混淆的规则放在一起辨析", nextStrategy: "discriminate", branchStrategy: "explain" },
  { path: "execution-failed", label: "我会，但没写出来", hint: "再提取一次，这次要求写出完整表述", nextStrategy: "produce", branchStrategy: "continue" },
];

/**
 * What the next generation call should be told, given the action that was
 * actually recorded for this task.
 *
 * Returns the system-owned action (which always travels) plus the branch
 * strategy to request (which is the regime hint seen by the generator).
 * A task with no recorded action returns `undefined`, so the v1 branch-based
 * path keeps behaving exactly as before.
 */
export const interventionDirectiveFor = (
  events: readonly TaskOutcomeEvent[],
): { path: InterventionPath; action: InterventionStrategy; branchStrategy: InterventionAction["branchStrategy"] } | undefined => {
  const latest = events
    .filter((event) => event.kind === "intervention-selected" && event.interventionPath)
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))
    .at(-1);
  if (!latest?.interventionPath) return undefined;
  const action = interventionActionFor(latest.interventionPath);
  return { path: action.path, action: action.nextStrategy, branchStrategy: action.branchStrategy };
};

export const interventionActionFor = (path: InterventionPath): InterventionAction => {
  const action = INTERVENTION_ACTIONS.find((item) => item.path === path);
  if (!action) throw new Error(`Unknown intervention path: ${path}`);
  return action;
};

/**
 * The anti-self-esteem rule (constitution art. 6).
 *
 * A learner who has twice said "I can but did not produce it" is not being
 * helped by a third production attempt. Rather than let them keep choosing the
 * flattering option, the third round is downgraded to `not-formed`, which
 * sends them back to the material. This is a system decision, taken from the
 * event count, and it is not negotiable from the UI.
 */
export const MAX_CONSECUTIVE_EXECUTION_FAILED = 2;

export interface InterventionChoiceResolution {
  /** The path that will actually be recorded. */
  path: InterventionPath;
  /** The path the learner selected, before any downgrade. */
  requested: InterventionPath;
  /** True when the system overrode the learner's selection. */
  downgraded: boolean;
  consecutiveExecutionFailed: number;
  action: InterventionAction;
}

export const resolveInterventionChoice = (
  requested: InterventionPath,
  events: readonly TaskOutcomeEvent[],
): InterventionChoiceResolution => {
  const streak = consecutiveExecutionFailedCount(events);
  const downgraded = requested === "execution-failed" && streak >= MAX_CONSECUTIVE_EXECUTION_FAILED;
  const path: InterventionPath = downgraded ? "not-formed" : requested;
  return {
    path,
    requested,
    downgraded,
    consecutiveExecutionFailed: streak,
    action: interventionActionFor(path),
  };
};

export interface InterventionOption {
  path: InterventionPath;
  label: string;
  hint: string;
  /** True when choosing this option would be overridden to the material path. */
  forced: boolean;
}

/**
 * The options actually shown to the learner. When the execution-failed streak
 * is at the cap, that option is shown as unavailable-with-explanation rather
 * than silently missing: hiding it would look like a bug and would let the
 * learner keep believing it is still on the table.
 */
export const interventionOptionsFor = (events: readonly TaskOutcomeEvent[]): InterventionOption[] => {
  const streak = consecutiveExecutionFailedCount(events);
  return INTERVENTION_ACTIONS.map((action) => ({
    path: action.path,
    label: action.label,
    hint: action.hint,
    forced: action.path === "execution-failed" && streak >= MAX_CONSECUTIVE_EXECUTION_FAILED,
  }));
};

/**
 * Independence is a property of the retrieval, and every form of help breaks it.
 *
 * `hintsUsed` covers the tiered hints. A full-answer reveal is tracked the same
 * way - as a hint level at the maximum - so there is one place that decides
 * whether a retrieval was independent. Anything the learner used to reach the
 * answer means the answer is not evidence of independent recall.
 */
export const ASSISTED_AFTER_HINTS = 1;

export const independenceForTurn = (hintsUsedCount: number): "independent" | "assisted" => (
  hintsUsedCount >= ASSISTED_AFTER_HINTS ? "assisted" : "independent"
);
