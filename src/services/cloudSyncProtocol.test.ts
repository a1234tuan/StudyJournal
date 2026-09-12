import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../db/defaults";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT } from "../features/reviewCoach/domain";
import { completeCoachTestSnapshot } from "../features/reviewCoach/reviewCoachTestFixtures";
import type { CloudSyncLedgerRecord, RecordBlock, RecordReviewLog, StorageSnapshot } from "../types";
import { exportCloudSync, findConflictingChanges } from "./cloudSyncModel";

vi.mock("./firebase", () => ({
  firebaseAuth: { currentUser: null },
  firebaseStorage: {},
  firestore: {},
  googleAuthProvider: {},
}));

const { canSkipCloudSyncLock, deriveLocalCloudChanges, normalizeRemoteEntity } = await import("./cloudSyncService");

const stamp = "2026-09-07T08:00:00.000Z";
const record: RecordBlock = {
  id: "record-1",
  type: "record",
  date: "2026-09-07",
  order: 0,
  subject: "OS",
  title: "Baseline",
  contentHtml: "<p>baseline</p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
  tags: [],
  createdAt: stamp,
  updatedAt: stamp,
};

const snapshot = (overrides: Partial<StorageSnapshot["payload"]> = {}): StorageSnapshot => ({
  payload: {
    manifest: { format: "study-journal", version: 6, exportedAt: stamp, appVersion: "0.1.0", counts: { entries: 0, blocks: 1, mistakes: 0, assets: 0, tags: 0, reviews: 0, studySessions: 0 } },
    entries: [],
    blocks: [record],
    templates: [],
    recordDrafts: [],
    mistakes: [],
    tags: [],
    reviews: [],
    recordReviews: [],
    recordReviewLogs: [],
    recordReviewDayStats: [],
    studySessions: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    reviewCoach: structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT),
    ...overrides,
  },
  assets: [],
});

const ledgerFor = (exported: Awaited<ReturnType<typeof exportCloudSync>>, revision = 1): CloudSyncLedgerRecord[] => [
  ...exported.entities.map((entity) => ({
    id: entity.key,
    entityType: entity.entityType,
    entityId: entity.entityId,
    contentHash: entity.contentHash,
    contentHashVersion: entity.contentHashVersion,
    contentHashAlgorithm: entity.contentHashAlgorithm,
    cloudRevision: revision,
  })),
  ...exported.reviewEvents.map((event) => ({ id: `review-event:${event.id}`, entityType: "review-event" as const, entityId: event.id, contentHash: event.contentHash, cloudRevision: revision })),
];

describe("two-device incremental sync protocol", () => {
  it("keeps device-local AI and TTS profiles out of two-device sync", async () => {
    const desktopSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ai: { currentProviderId: "desktop-ai", providers: [{ id: "desktop-ai", providerName: "Desktop AI", baseUrl: "https://desktop.invalid", model: "desktop-model", temperature: 0.2, maxTokens: 320 }], presets: [] },
      tts: { currentProviderId: "desktop-tts", providers: [{ id: "desktop-tts", providerId: "fish-audio" as const, providerName: "Desktop TTS", model: "desktop-model", voice: "desktop-voice" }] },
    };
    const androidSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ai: { currentProviderId: "android-ai", providers: [{ id: "android-ai", providerName: "Android AI", baseUrl: "https://android.invalid", model: "android-model", temperature: 0.2, maxTokens: 320 }], presets: [] },
      tts: { currentProviderId: "android-tts", providers: [{ id: "android-tts", providerId: "doubao" as const, providerName: "Android TTS", model: "android-model", voice: "android-voice" }] },
    };
    const desktop = await exportCloudSync(snapshot({ settings: desktopSettings }));
    const android = await exportCloudSync(snapshot({ settings: androidSettings }));
    const desktopSettingsEntity = desktop.entities.find((entity) => entity.key === "settings:settings")!;
    const androidSettingsEntity = android.entities.find((entity) => entity.key === "settings:settings")!;

    expect(desktopSettingsEntity.payload.ai).toBeUndefined();
    expect(desktopSettingsEntity.payload.tts).toBeUndefined();
    expect(androidSettingsEntity.payload.ai).toBeUndefined();
    expect(androidSettingsEntity.payload.tts).toBeUndefined();
    expect(desktopSettingsEntity.contentHash).toBe(androidSettingsEntity.contentHash);
    expect(await deriveLocalCloudChanges(android, ledgerFor(desktop))).toEqual({ entities: [], events: [] });

    const normalizedLegacyRemote = await normalizeRemoteEntity({
      ...androidSettingsEntity,
      payload: androidSettings as unknown as Record<string, unknown>,
      contentHash: "legacy-settings-hash",
      revision: 2,
    });
    expect(normalizedLegacyRemote.payload.ai).toBeUndefined();
    expect(normalizedLegacyRemote.payload.tts).toBeUndefined();
    expect(normalizedLegacyRemote.contentHash).toBe(desktopSettingsEntity.contentHash);
  });

  it("does not report a conflict when only the phone edited a record", async () => {
    const base = await exportCloudSync(snapshot());
    const ledger = ledgerFor(base);
    const desktopChanges = await deriveLocalCloudChanges(base, ledger);
    const phone = await exportCloudSync(snapshot({ blocks: [{ ...record, title: "Phone edit" }] }));
    const phoneChanges = await deriveLocalCloudChanges(phone, ledger);

    expect(desktopChanges.entities).toEqual([]);
    expect(findConflictingChanges(desktopChanges.entities, phoneChanges.entities)).toEqual([]);
    expect(phoneChanges.entities.map((entity) => entity.key)).toEqual(["block:record-1"]);
  });

  it("treats edit then undo as identical to the synced baseline", async () => {
    const base = await exportCloudSync(snapshot());
    const ledger = ledgerFor(base);
    const undone = await exportCloudSync(snapshot({ blocks: [{ ...record, updatedAt: "2026-09-07T09:00:00.000Z" }] }));

    expect(await deriveLocalCloudChanges(undone, ledger)).toEqual({ entities: [], events: [] });
  });

  it("publishes rating and undo events once, then becomes idempotent", async () => {
    const base = await exportCloudSync(snapshot());
    const logBase = {
      recordId: record.id,
      rating: "good" as const,
      reviewedAt: stamp,
      previousEaseFactor: 2.5,
      nextEaseFactor: 2.5,
      previousRepetition: 0,
      nextRepetition: 1,
      previousIntervalDays: 0,
      nextIntervalDays: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const rating: RecordReviewLog = { ...logBase, id: "rating-1", eventType: "rating" };
    const undo: RecordReviewLog = { ...logBase, id: "undo-1", eventType: "rating-undone", revertedEventId: rating.id };
    const reviewed = await exportCloudSync(snapshot({ recordReviewLogs: [rating, undo] }));
    const firstChanges = await deriveLocalCloudChanges(reviewed, ledgerFor(base));

    expect(firstChanges.events.map((event) => event.id)).toEqual(["rating-1", "undo-1"]);
    expect((await deriveLocalCloudChanges(reviewed, ledgerFor(reviewed, 2))).events).toEqual([]);
  });

  it("detects all changed AI cockpit facts incrementally and skips locks only for a true no-op", async () => {
    const base = await exportCloudSync(snapshot());
    const coached = await exportCloudSync(snapshot({ reviewCoach: completeCoachTestSnapshot() }));
    const changes = await deriveLocalCloudChanges(coached, ledgerFor(base));
    const coachTypes = new Set(changes.entities.map((entity) => entity.entityType));

    expect(coachTypes).toEqual(new Set([
      "decision-block", "decision-block-feedback", "feedback-interpretation", "analysis-queue-item",
      "analysis-batch", "session-blueprint", "adaptive-review-task", "adaptive-quiz-turn",
      "task-outcome-event", "delayed-verification",
    ]));
    expect(canSkipCloudSyncLock(false, true, 3, 3, { entities: [], events: [] })).toBe(true);
    expect(canSkipCloudSyncLock(false, true, 4, 3, { entities: [], events: [] })).toBe(false);
    expect(canSkipCloudSyncLock(false, true, 3, 3, changes)).toBe(false);
  });
});
