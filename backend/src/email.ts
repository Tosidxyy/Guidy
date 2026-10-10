export interface EmailEnv {
  RESEND_API_KEY?: string;
  GUIDY_EMAIL_FROM?: string;
  GUIDY_EMAIL_TEST_TO?: string;
}
export class EmailDeliveryError extends Error {
  readonly code: string;
  constructor(code: string = "OTP_DELIVERY_FAILED") {
    super("OTP email delivery failed");
    this.code = code;
  }
}
export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}
export async function sendOtpEmail(
  env: EmailEnv,
  email: string,
  otp: string,
  fetcher: typeof fetch = (...args) => fetch(...args),
): Promise<void> {
  if (
    !env.RESEND_API_KEY ||
    !env.GUIDY_EMAIL_FROM ||
    !validEmail(env.GUIDY_EMAIL_FROM) ||
    !validEmail(email) ||
    !/^\d{6}$/.test(otp)
  )
    throw new Error("Email not configured");
  const key = env.RESEND_API_KEY.trim();
  if (!key || /[^\x21-\x7e]/.test(key))
    throw new EmailDeliveryError("EMAIL_PROVIDER_AUTH_FAILED");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let received = false;
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      // workerd supports follow/manual only. Non-2xx (including redirects) fail below.
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `guidy-otp-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        from: `Guidy <${env.GUIDY_EMAIL_FROM}>`,
        to: [email],
        subject: "你的 Guidy 登录验证码",
        text: `你的登录验证码是 ${otp}，5 分钟内有效。请勿分享验证码。如果不是你本人操作，请忽略本邮件。\n\nGuidy · Chat & Do It.`,
      }),
    });
    received = true;
    if (!response.ok) {
      // Classify status only. Provider bodies can contain credentials and addresses.
      const code =
        response.status === 401
          ? "EMAIL_PROVIDER_AUTH_FAILED"
          : response.status === 403
            ? "EMAIL_PROVIDER_REJECTED"
            : response.status === 429
              ? "EMAIL_PROVIDER_RATE_LIMITED"
              : response.status >= 500
                ? "EMAIL_PROVIDER_UNAVAILABLE"
                : "EMAIL_PROVIDER_INVALID_REQUEST";
      throw new EmailDeliveryError(code);
    }
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("id" in result) ||
      typeof result.id !== "string" ||
      !result.id
    )
      throw new Error("Invalid delivery response");
  } catch (err) {
    // Provider response bodies may contain addresses, credentials or message content.
    if (err instanceof EmailDeliveryError) throw err;
    const runtimeFailure =
      err instanceof Error &&
      /illegal invocation|incorrect this|different request|outside.*request/i.test(
        err.message,
      );
    throw new EmailDeliveryError(
      controller.signal.aborted
        ? "EMAIL_PROVIDER_TIMEOUT"
        : received
          ? "EMAIL_PROVIDER_INVALID_RESPONSE"
          : runtimeFailure
            ? "EMAIL_PROVIDER_RUNTIME_ERROR"
            : "EMAIL_PROVIDER_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timer);
  }
}
