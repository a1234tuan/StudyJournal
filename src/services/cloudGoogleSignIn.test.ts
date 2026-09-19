import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CloudGoogleSignInError,
  NATIVE_GOOGLE_SIGN_IN_TIMEOUT_MS,
  cloudGoogleSignInErrorMessage,
  runNativeGoogleSignIn,
} from "./cloudGoogleSignIn";

describe("runNativeGoogleSignIn", () => {
  afterEach(() => vi.useRealTimers());

  it("exchanges the native id token without signing into the native Firebase session", async () => {
    const exchange = vi.fn().mockResolvedValue("web-user");

    await expect(runNativeGoogleSignIn(
      () => Promise.resolve({ credential: { idToken: "id-token", accessToken: "access-token" } }),
      exchange,
    )).resolves.toBe("web-user");

    expect(exchange).toHaveBeenCalledWith({ idToken: "id-token", accessToken: "access-token" });
  });

  it("reports a configuration failure when native auth returns no id token", async () => {
    const exchange = vi.fn();

    await expect(runNativeGoogleSignIn(
      () => Promise.resolve({ credential: { accessToken: "access-token" } }),
      exchange,
    )).rejects.toMatchObject({ kind: "configuration" });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("times out a native request that never returns and permits a fresh attempt", async () => {
    vi.useFakeTimers();
    const stuckAttempt = runNativeGoogleSignIn(
      () => new Promise(() => undefined),
      vi.fn(),
    );
    const timedOut = expect(stuckAttempt).rejects.toMatchObject({ kind: "not-opened" });

    await vi.advanceTimersByTimeAsync(NATIVE_GOOGLE_SIGN_IN_TIMEOUT_MS);
    await timedOut;

    await expect(runNativeGoogleSignIn(
      () => Promise.resolve({ credential: { idToken: "retry-token" } }),
      async ({ idToken }) => idToken,
    )).resolves.toBe("retry-token");
  });
});

describe("cloudGoogleSignInErrorMessage", () => {
  it("distinguishes user cancellation and tells the user that retry is available", () => {
    expect(cloudGoogleSignInErrorMessage(new Error("androidx.credentials.exceptions.GetCredentialCancellationException")))
      .toBe("Google 登录已取消。你可以再次点击「使用 Google 登录」重试。");
  });

  it("distinguishes a login surface that could not be provided", () => {
    expect(cloudGoogleSignInErrorMessage(new Error("GetCredentialProviderConfigurationException")))
      .toContain("未能唤起可用的 Google 登录界面");
  });

  it("distinguishes network and proxy routing failures", () => {
    expect(cloudGoogleSignInErrorMessage(new Error("Unable to resolve host accounts.google.com")))
      .toContain("系统代理或 VPN 已接管本应用流量");
  });

  it("preserves authored timeout and configuration guidance", () => {
    const error = new CloudGoogleSignInError("not-opened", "登录界面没有返回。请重试。");
    expect(cloudGoogleSignInErrorMessage(error)).toBe("登录界面没有返回。请重试。");
  });

  it("leaves unknown provider details to the generic safe error formatter", () => {
    expect(cloudGoogleSignInErrorMessage(new Error("internal provider detail"))).toBeUndefined();
  });
});
