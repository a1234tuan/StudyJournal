import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import type { RecordBlock } from "../../types";
import { DexieReviewCoachRepository, restoreReviewCoachFormalSnapshot, reviewCoachRestoreTables } from "./repository";
import {
    coachTestAnswerOutcome,
    coachTestBatch,
    coachTestBlock,
    coachTestBlueprint,
    coachTestFeedback,
    coachTestInterpretation,
    coachTestQueueItem,
    coachTestStamp,
    coachTestTask,
    coachTestTurn,
    coachTestVerification,
    completeCoachTestSnapshot,
} from "./reviewCoachTestFixtures";
import { ReviewCoachOrchestrator } from "./orchestrator";
import { ReviewCoachValidationError } from "./validation";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const record: RecordBlock = {
    id: "record-1", createdAt: coachTestStamp, updatedAt: coachTestStamp, type: "record",
    date: "2026-09-04", order: 0, subject: "Data Structures", title: "BFS",
    contentHtml: "<p>BFS uses a queue.</p>", assets: [], formulas: [], mistakeRefs: [], tags: [],
};
const later = "2026-09-21T10:00:00.000Z";

let database: StudyJournalDatabase;
let repository: DexieReviewCoachRepository;

async function boot() {
    database = new StudyJournalDatabase(`wb-coach-${crypto.randomUUID()}`);
    await database.open();
    await database.blocks.put(record);
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, completeCoachTestSnapshot()));
    repository = new DexieReviewCoachRepository(database);
    return database;
}

afterEach(async () => {
    vi.restoreAllMocks();
    if (!database) return;
    const name = database.name;
    database.close();
    await Dexie.delete(name);
    database = undefined as any;
});

const mutation = () => database.cloudSyncMutation.toArray();

describe("W-03 interpretation rewrite in the presence of a soft-deleted row", () => {
    it("rewrites the same interpretation id instead of failing on the retained row", async () => {
        await boot();
        const deletedRow = { ...coachTestInterpretation, deletedAt: later, updatedAt: later };
        await database.feedbackInterpretations.put(deletedRow);

        const saved = await repository.saveFeedbackInterpretation(
            { ...coachTestInterpretation, status: "succeeded", updatedAt: later },
            deletedRow,
        );
        expect(saved).toMatchObject({ id: coachTestInterpretation.id, status: "succeeded" });

        // The duplicate guard must still protect a different id for the same feedback.
        await expect(repository.saveFeedbackInterpretation(
            { ...coachTestInterpretation, id: "interpretation-elsewhere", updatedAt: later },
            deletedRow,
        )).rejects.toMatchObject({ code: expect.stringMatching(/duplicate|stale/) });
    });
});

describe("W-14b queue no-op paths", () => {
    it("does not bump the mutation epoch for an unchanged note or a redundant requeue", async () => {
        await boot();
        const eligible = { ...coachTestQueueItem, status: "eligible" as const, batchId: undefined, consumedAt: undefined, analysisNote: "keep me" };
        await database.analysisQueueItems.put(eligible);
        const before = await mutation();

        await repository.updateQueueItemAnalysisNote(eligible.id, "keep me", later);
        expect(await mutation()).toEqual(before);
        await repository.updateQueueItemAnalysisNote(eligible.id, "  keep me  ", later);
        expect(await mutation()).toEqual(before);

        await repository.requeueAnalysisQueueItem(eligible.id, later);
        expect(await mutation()).toEqual(before);
        expect(await database.analysisQueueItems.get(eligible.id)).toEqual(eligible);

        await repository.updateQueueItemAnalysisNote(eligible.id, "changed", later);
        expect(await mutation()).not.toEqual(before);
    });
});

describe("W-20 a single uncontended analysis run can persist its outputs", () => {
    it("keeps the captured batch version valid across blueprint and task writes", async () => {
        await boot();
        await database.analysisBatches.put({ ...coachTestBatch, status: "running", completedAt: undefined, subBatches: [{ ...coachTestBatch.subBatches[0], status: "pending" }] });
        const previous = (await database.analysisBatches.get(coachTestBatch.id))!;
        const running = await repository.updateAnalysisBatch({
            ...previous,
            subBatches: [{ ...previous.subBatches[0], status: "pending" }], updatedAt: later,
        }, previous);
        expect(running.status).toBe("running");

        const blueprint = await repository.acceptBlueprint(
            { ...coachTestBlueprint, id: "blueprint-2", idempotencyKey: "blueprint-operation-2", updatedAt: later },
            running,
        );
        expect(blueprint).toMatchObject({ id: "blueprint-2", status: "accepted" });

        const task = await repository.createTask({
            ...coachTestTask, id: "task-2", blueprintId: "blueprint-2", status: "waiting",
            startedAt: undefined, endedAt: undefined, idempotencyKey: "task-operation-2", updatedAt: later,
        }, running);
        expect(task).toMatchObject({ id: "task-2", status: "waiting" });

        const finished = await repository.updateAnalysisBatch({
            ...running, status: "succeeded",
            subBatches: [{ ...running.subBatches[0], status: "succeeded" }], updatedAt: later,
        }, running);
        expect(finished.status).toBe("succeeded");
        expect((await database.analysisBatches.get(coachTestBatch.id))!.status).toBe("succeeded");
    });

    it("still rejects a candidate whose batch moved on", async () => {
        await boot();
        const previous = (await database.analysisBatches.get(coachTestBatch.id))!;
        await database.analysisBatches.put({ ...previous, status: "running", updatedAt: later });

        let failure: unknown;
        try {
            await repository.acceptBlueprint(
                { ...coachTestBlueprint, id: "blueprint-2", idempotencyKey: "blueprint-operation-2", updatedAt: later },
                previous,
            );
        } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(ReviewCoachValidationError);
        expect((failure as ReviewCoachValidationError).code).toBe("stale-analysis-batch");
    });
});

describe("W-21 refreshing a failed interpretation", () => {
    it("re-runs a failed interpretation without a stale guard rejection", async () => {
        await boot();
        const failed = { ...coachTestInterpretation, status: "failed" as const, errorCode: "network", updatedAt: later };
        await database.feedbackInterpretations.put(failed);

        const interpretFeedback = vi.fn(async () => ({
            response: {
                status: "ok" as const, actionability: "needs_training" as const, difficultyType: "procedure" as const,
                stuckAt: "visited marking", userHypothesis: null, preferredPractice: null, missingInformation: [], confidence: 0.9,
            },
        }));
        const orchestrator = new ReviewCoachOrchestrator({
            repository, ids: { next: () => "generated-1" }, clock: { now: () => later },
            aiGateway: { interpretFeedback, planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() } as any,
        });

        const result = await orchestrator.interpretFeedback({
            feedbackId: coachTestFeedback.id, decisionBlockContent: "source", provider: "test", model: "test",
            promptVersion: "test", policyVersion: "test", schemaVersion: 1,
        });

        expect(result.status).toBe("succeeded");
        expect(interpretFeedback).toHaveBeenCalledTimes(1);
        expect(await database.feedbackInterpretations.get(coachTestInterpretation.id)).toMatchObject({ status: "succeeded" });
    });
});

describe("W-22 what a stale rejection leaves behind", () => {
    it("keeps the batch and queue recoverable and writes nothing else", async () => {
        await boot();
        const stale = (await database.analysisBatches.get(coachTestBatch.id))!;
        const remoteVersion = { ...stale, status: "running" as const, updatedAt: later };
        await database.analysisBatches.put(remoteVersion);
        const before = await mutation();
        const blueprintsBefore = await database.sessionBlueprints.count();
        const tasksBefore = await database.adaptiveReviewTasks.count();
        const queueBefore = await database.analysisQueueItems.toArray();

        await expect(repository.updateAnalysisBatch(
            { ...stale, status: "succeeded", updatedAt: "2026-09-21T11:00:00.000Z" },
            stale,
        )).rejects.toMatchObject({ code: "stale-analysis-batch" });

        expect(await database.analysisBatches.get(coachTestBatch.id)).toEqual(remoteVersion);
        expect(await mutation()).toEqual(before);
        expect(await database.sessionBlueprints.count()).toBe(blueprintsBefore);
        expect(await database.adaptiveReviewTasks.count()).toBe(tasksBefore);
        expect(await database.analysisQueueItems.toArray()).toEqual(queueBefore);
    });
});

describe("W-23 quiz answer commit guards", () => {
    async function seedQuiz() {
        await boot();
        const task = { ...coachTestTask, id: "task-2", status: "in-progress" as const, startedAt: coachTestStamp, endedAt: undefined, idempotencyKey: "task-operation-2" };
        const turn = {
            ...coachTestTurn, id: "turn-2", taskId: "task-2", status: "displayed" as const, sequence: 2,
            answerText: undefined, answeredAt: undefined, assessment: undefined, assessmentRationale: undefined,
            idempotencyKey: "turn-operation-2",
        };
        await database.adaptiveReviewTasks.put(task);
        await database.adaptiveQuizTurns.put(turn);
        const submitted = { ...turn, answerText: "Mark it before enqueueing.", answeredAt: later, assessment: "correct" as const, updatedAt: later };
        const event = { ...coachTestAnswerOutcome, id: "outcome-answer-2", taskId: "task-2", turnId: "turn-2", idempotencyKey: "outcome-answer-operation-2" };
        return { task, turn, submitted, event };
    }

    it("commits once, is idempotent on retry, and tolerates unrelated record edits", async () => {
        const { submitted, event } = await seedQuiz();
        await expect(repository.commitQuizAnswer(submitted, event)).resolves.toMatchObject({ id: "turn-2", status: "answered" });
        expect(await database.taskOutcomeEvents.where("idempotencyKey").equals(event.idempotencyKey).count()).toBe(1);

        const afterCommit = await mutation();
        await expect(repository.commitQuizAnswer(submitted, event)).resolves.toMatchObject({ status: "answered" });
        expect(await database.taskOutcomeEvents.where("idempotencyKey").equals(event.idempotencyKey).count()).toBe(1);
        expect(await mutation()).toEqual(afterCommit);

        // An unrelated edit to the source record must not invalidate a later answer.
        await database.blocks.put({ ...record, title: "BFS (renamed elsewhere)" });
        const nextTurn = {
            ...submitted, id: "turn-3", sequence: 3, status: "displayed" as const,
            answerText: undefined, answeredAt: undefined, assessment: undefined, idempotencyKey: "turn-operation-3",
        };
        await database.adaptiveQuizTurns.put(nextTurn);
        const nextEvent = { ...event, id: "outcome-answer-3", turnId: "turn-3", idempotencyKey: "outcome-answer-operation-3" };
        await expect(repository.commitQuizAnswer(
            { ...nextTurn, answerText: "Before enqueueing.", answeredAt: later, assessment: "correct", updatedAt: later },
            nextEvent,
        )).resolves.toMatchObject({ id: "turn-3", status: "answered" });
    });

    it("refuses an answer whose task already left in-progress without half-writing", async () => {
        const { task, submitted, event } = await seedQuiz();
        await database.adaptiveReviewTasks.put({ ...task, status: "completed", endedAt: later });
        const before = await mutation();

        await expect(repository.commitQuizAnswer(submitted, event)).rejects.toMatchObject({ code: "inactive-task" });

        expect((await database.adaptiveQuizTurns.get("turn-2"))!.status).toBe("displayed");
        expect(await mutation()).toEqual(before);
        expect(await database.taskOutcomeEvents.where("idempotencyKey").equals(event.idempotencyKey).count()).toBe(0);
    });

    it("refuses an answer generated from a superseded turn or task snapshot", async () => {
        const { task, submitted, event } = await seedQuiz();
        await expect(repository.commitQuizAnswer(submitted, event, undefined, {
            turn: { ...submitted, updatedAt: "2026-09-21T09:00:00.000Z" }, task,
        })).rejects.toMatchObject({ code: "stale-quiz-answer" });
        expect((await database.adaptiveQuizTurns.get("turn-2"))!.status).toBe("displayed");
    });
});

describe("W-24 task transitions keep evidence timestamps and respect verification due-ness", () => {
    it("does not refresh endedAt or deletedAt on a repeated transition", async () => {
        await boot();
        const completed = (await database.adaptiveReviewTasks.get(coachTestTask.id))!;
        const before = await mutation();
        const returned = await repository.transitionTask(coachTestTask.id, "completed", later);
        expect(returned).toEqual(completed);
        expect(returned.endedAt).toBe(coachTestStamp);
        expect(await mutation()).toEqual(before);

        const sameReason = await repository.transitionTask(coachTestTask.id, "completed", later, completed.terminalReason);
        expect(sameReason.endedAt).toBe(coachTestStamp);
    });

    it("does not pull a due recheck back into the queue when its task restarts", async () => {
        await boot();
        const task = { ...coachTestTask, id: "task-2", status: "waiting" as const, priorityTier: "due-verification" as const, startedAt: undefined, endedAt: undefined, idempotencyKey: "task-operation-2" };
        await database.adaptiveReviewTasks.put(task);
        await repository.switchCurrentTask("task-2", later);
        await database.delayedVerifications.put({
            ...coachTestVerification, taskId: "task-2", status: "completed",
            concludedAt: undefined, nextVerificationDueAt: "2026-09-20T00:00:00.000Z",
        });

        await repository.transitionTask("task-2", "in-progress", later);

        const verification = (await database.delayedVerifications.get(coachTestVerification.id))!;
        expect(verification.status).toBe("completed");
        expect(verification.taskId).toBe("task-2");
    });

    it("still re-queues a settled verification that is not due again", async () => {
        await boot();
        const task = { ...coachTestTask, id: "task-2", status: "waiting" as const, priorityTier: "due-verification" as const, startedAt: undefined, endedAt: undefined, idempotencyKey: "task-operation-2" };
        await database.adaptiveReviewTasks.put(task);
        await repository.switchCurrentTask("task-2", later);
        await database.delayedVerifications.put({ ...coachTestVerification, taskId: "task-2", status: "eligible" });

        await repository.transitionTask("task-2", "in-progress", later);

        expect((await database.delayedVerifications.get(coachTestVerification.id))!.status).not.toBe("eligible");
    });
});

describe("W-25 detaching a verification whose task disappeared", () => {
    it("rejects a corrupt task link without silently rewriting formal evidence", async () => {
        await boot();
        await database.delayedVerifications.put({ ...coachTestVerification, taskId: "task-that-was-purged", status: "queued" });

        const before = await database.delayedVerifications.get(coachTestVerification.id);
        const epoch = await mutation();
        await expect(repository.detachVerificationTask(coachTestVerification.id, later)).rejects.toMatchObject({ code: "dangling-task" });
        expect(await database.delayedVerifications.get(coachTestVerification.id)).toEqual(before);
        expect(await mutation()).toEqual(epoch);
    });
});
