import { describe, expect, it, vi } from "vitest";
import { CommittedWriteError, createCommittedWriteRetry, finishCommittedWrite } from "./committedWrite";

describe("committed write follow-ups", () => {
  it("coalesces concurrent retries without duplicating a follow-up", async () => {
    let release!: () => void;
    const action = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const retry = createCommittedWriteRetry([action]);
    const first = retry();
    const second = retry();
    expect(first).toBe(second);
    expect(action).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    await retry();
    expect(action).toHaveBeenCalledOnce();
  });
  it("returns the committed value without repeating successful steps on retry", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const failing = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const last = vi.fn().mockResolvedValue(undefined);
    const value = { id: "saved" };
    const error = await finishCommittedWrite(value, [first, failing, last]).catch(error => error);
    expect(error).toBeInstanceOf(CommittedWriteError);
    expect(error.value).toBe(value);
    await error.retry();
    await error.retry();
    expect(first).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(last).toHaveBeenCalledTimes(1);
  });
});
