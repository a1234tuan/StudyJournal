export type CloudGoogleSignInErrorKind = "cancelled" | "not-opened" | "network" | "configuration";

export class CloudGoogleSignInError extends Error {
  constructor(
    readonly kind: CloudGoogleSignInErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CloudGoogleSignInError";
  }
}

interface NativeGoogleCredentialResult {
  credential?: {
    idToken?: string | null;
    accessToken?: string | null;
  } | null;
}

interface NativeGoogleCredential {
  idToken: string;
  accessToken: string | null;
}

export const NATIVE_GOOGLE_SIGN_IN_TIMEOUT_MS = 90_000;

const withNativeGoogleSignInTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new CloudGoogleSignInError(
            "not-opened",
            "Google 登录界面未能打开，或打开后没有返回结果。请返回本页后重试。",
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

export const runNativeGoogleSignIn = async <T>(
  launch: () => Promise<NativeGoogleCredentialResult>,
  exchangeCredential: (credential: NativeGoogleCredential) => Promise<T>,
  timeoutMs = NATIVE_GOOGLE_SIGN_IN_TIMEOUT_MS,
): Promise<T> => {
  const result = await withNativeGoogleSignInTimeout(launch(), timeoutMs);
  const idToken = result.credential?.idToken;
  if (!idToken) {
    throw new CloudGoogleSignInError(
      "configuration",
      "Google 登录没有返回身份令牌。请确认 Android 应用签名指纹与 google-services.json 配置一致。",
    );
  }
  return exchangeCredential({ idToken, accessToken: result.credential?.accessToken ?? null });
};

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return `${typeof code === "string" ? `${code} ` : ""}${error.name} ${error.message}`.toLowerCase();
  }
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    return `${typeof value.code === "string" ? value.code : ""} ${typeof value.message === "string" ? value.message : ""}`.toLowerCase();
  }
  return String(error ?? "").toLowerCase();
};

export const cloudGoogleSignInErrorMessage = (error: unknown): string | undefined => {
  if (error instanceof CloudGoogleSignInError) return error.message;

  const text = errorText(error);
  if (/cancel(?:led|ed|lation)|canceled|user.*closed|activity.*result.*0|getcredentialcancellationexception/.test(text)) {
    return "Google 登录已取消。你可以再次点击「使用 Google 登录」重试。";
  }
  if (/network|unable to resolve host|connection|api_exception:\s*7|timeout|timed out/.test(text)) {
    return "Google 登录无法连接 Google 或 Firebase。请确认系统代理或 VPN 已接管本应用流量，然后重试。";
  }
  if (/no.?credential|getcredentialproviderconfigurationexception|getcredentialunsupportedexception|provider.?configuration|unsupported|activitynotfound|activity not found|no provider/.test(text)) {
    return "未能唤起可用的 Google 登录界面。请确认设备已添加 Google 账号，并更新 Google Play 服务后重试。";
  }
  if (/developer_error|api_exception:\s*10|sha-?1|google-services|id.?token/.test(text)) {
    return "Google 登录配置校验失败。请确认当前安装包的签名指纹已登记，并使用匹配的 google-services.json。";
  }
  return undefined;
};
