import { afterEach, describe, expect, it, vi } from "vitest";
import { pendingReviewNavigation, registerReviewNavigationCheck } from "./navigationGuard";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

describe("review navigation checks", () => {
  it("allows navigation synchronously when there are no unsaved changes", () => {
    cleanups.push(registerReviewNavigationCheck(() => undefined));
    expect(pendingReviewNavigation()).toBeUndefined();
  });

  it("waits for all registered pending writes", async () => {
    let complete!: () => void;
    const saving = new Promise<void>((resolve) => { complete = resolve; });
    cleanups.push(registerReviewNavigationCheck(() => saving));
    const navigate = vi.fn();
    const pending = pendingReviewNavigation()!.then(navigate);
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    complete();
    await pending;
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("rejects navigation on a failed write and removes checks on unmount", async () => {
    const remove = registerReviewNavigationCheck(() => Promise.reject(new Error("save failed")));
    cleanups.push(remove);
    await expect(pendingReviewNavigation()).rejects.toThrow("save failed");
    remove();
    expect(pendingReviewNavigation()).toBeUndefined();
  });
});
