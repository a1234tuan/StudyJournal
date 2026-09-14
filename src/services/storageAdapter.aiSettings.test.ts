import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiProviderConfig, AppSettings } from "../types";

type MigrationCapableAdapter = {
  migrateAiSettings(): Promise<void>;
};

const legacyAi = (patch: Partial<AiProviderConfig> & { baseUrl?: string; model?: string; providerName?: string }) =>
  patch as unknown as AiProviderConfig;

/**
 * F-28 regression coverage for the legacy DeepSeek provider migration.
 *
 * The migration rewrites the retired `deepseek-chat` model to the seed model the
 * project actually verified (`deepseek-v4-flash`). Before the fix it rewrote to
 * `deepseek-v4-pro`, whose existence could not be confirmed, so a migrated install
 * would send its first AI request to a model id the API may not expose.
 */
describe("DexieStorageAdapter AI settings migration", () => {
  let settingsRow: { id: string } & Partial<AppSettings>;
  let putSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    settingsRow = { id: "settings" };
    putSpy = vi.fn(async (row: { id: string } & Partial<AppSettings>) => {
      settingsRow = row;
    });
  });

  afterEach(() => {
    vi.doUnmock("../db/database");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  const loadAdapter = async (): Promise<MigrationCapableAdapter> => {
    const db = {
      settings: {
        get: vi.fn(async (id: string) => (id === "settings" ? settingsRow : undefined)),
        put: putSpy,
      },
    };
    vi.doMock("../db/database", () => ({ db }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    return new DexieStorageAdapter() as unknown as MigrationCapableAdapter;
  };

  /** The single `ai` payload the migration wrote to the settings row. */
  const writtenAi = (): AiProviderConfig => {
    expect(putSpy).toHaveBeenCalledTimes(1);
    const written = putSpy.mock.calls[0][0] as AppSettings;
    expect(written.ai).toBeDefined();
    return written.ai as AiProviderConfig;
  };

  it("migrates the retired deepseek-chat model to the verified seed model", async () => {
    settingsRow.ai = legacyAi({
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    });

    const adapter = await loadAdapter();
    await adapter.migrateAiSettings();

    expect(writtenAi().providers[0]).toMatchObject({
      id: "default",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });
  });

  it("leaves a non-legacy model untouched while still normalising the legacy base URL", async () => {
    settingsRow.ai = legacyAi({
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
    });

    const adapter = await loadAdapter();
    await adapter.migrateAiSettings();

    expect(writtenAi().providers[0]).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });
  });

  it("is idempotent: re-running the migration writes nothing more", async () => {
    settingsRow.ai = legacyAi({
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    });

    const adapter = await loadAdapter();
    await adapter.migrateAiSettings();
    expect(putSpy).toHaveBeenCalledTimes(1);

    // settingsRow now holds the migrated shape, so the second pass must be a no-op.
    await adapter.migrateAiSettings();
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(settingsRow.ai?.providers[0]).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("seeds the verified model for a fresh install with no stored AI config", async () => {
    const adapter = await loadAdapter();
    await adapter.migrateAiSettings();

    expect(writtenAi().providers[0]).toMatchObject({
      id: "default",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });
  });
});
