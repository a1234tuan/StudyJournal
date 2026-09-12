import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../db/defaults";
import { preserveLocalSettings, sanitizeSettingsForExport, sanitizeStreamableSnapshotForExport, stripPrivateExportFields } from "./exportPrivacy";

describe("export privacy", () => {
  it("removes full prompts, raw provider data, and device-local backup fields", () => {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      lastBackupAt: "2026-09-07T08:00:00.000Z",
      syncFolderName: "D:/private-backups",
      knowledgePodcastModeTemplates: [{
        id: "podcast-template",
        title: "Local",
        prompt: "private podcast prompt",
        order: 0,
        createdAt: "2026-09-07T08:00:00.000Z",
        updatedAt: "2026-09-07T08:00:00.000Z",
      }],
    };

    const exported = sanitizeSettingsForExport(settings);

    expect(exported.lastBackupAt).toBeUndefined();
    expect(exported.syncFolderName).toBeUndefined();
    expect(exported.ai).toBeUndefined();
    expect(exported.tts).toBeUndefined();
    expect(exported.knowledgePodcastModeTemplates).toEqual([]);
    expect(JSON.stringify(exported)).not.toContain("private podcast prompt");
    expect(JSON.stringify(stripPrivateExportFields({ prompt: "secret", rawResponse: "raw", promptVersion: "v1" }))).toBe('{"promptVersion":"v1"}');
  });

  it("puts this device's prompts and backup fields back after a cloud restore", () => {
    const current = {
      ...structuredClone(DEFAULT_SETTINGS),
      syncFolderName: "D:/local-only",
      lastBackupAt: "2026-09-07T08:00:00.000Z",
    };
    const incoming = {
      ...sanitizeSettingsForExport({ ...current, theme: "dark" }),
      ai: { currentProviderId: "cloud-ai", providers: [], presets: [] },
      tts: { currentProviderId: "cloud-tts", providers: [] },
    } as typeof current;

    const restored = preserveLocalSettings(incoming, current);

    expect(restored.theme).toBe("dark");
    expect(restored.syncFolderName).toBe("D:/local-only");
    expect(restored.lastBackupAt).toBe("2026-09-07T08:00:00.000Z");
    expect(restored.ai).toEqual(current.ai);
    expect(restored.tts).toEqual(current.tts);
  });

  it("sanitizes hand-built streamable snapshots at native write boundaries", () => {
    const podcastAsset = {
      id: "podcast-audio",
      createdAt: "2026-09-07T08:00:00.000Z",
      updatedAt: "2026-09-07T08:00:00.000Z",
      fileName: "podcast.mp3",
      mimeType: "audio/mpeg",
      size: 5,
      kind: "audio" as const,
      generatedBy: "knowledge-podcast" as const,
    };
    const sanitized = sanitizeStreamableSnapshotForExport({
      payload: {
        manifest: { format: "study-journal", version: 6, exportedAt: "2026-09-07T08:00:00.000Z", appVersion: "0.1.0", counts: { entries: 0, blocks: 0, mistakes: 0, assets: 1, tags: 0, reviews: 0, studySessions: 0 } },
        entries: [], blocks: [], templates: [], mistakes: [], tags: [], reviews: [], studySessions: [],
        settings: { ...structuredClone(DEFAULT_SETTINGS), syncFolderName: "D:/private" },
        reviewCoach: { systemPrompt: "private" } as never,
      },
      assets: [podcastAsset],
    });

    expect(sanitized.assets).toEqual([]);
    expect(sanitized.payload.manifest.counts.assets).toBe(0);
    expect(JSON.stringify(sanitized)).not.toContain("D:/private");
    expect(JSON.stringify(sanitized)).not.toContain("systemPrompt");
  });
});
