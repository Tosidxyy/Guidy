export interface EmailEnv {
  RESEND_API_KEY?: string;
  GUIDY_EMAIL_FROM?: string;
  GUIDY_EMAIL_TEST_TO?: string;
}
export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}
export async function sendOtpEmail(
  env: EmailEnv,
  email: string,
  otp: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (
    !env.RESEND_API_KEY ||
    !env.GUIDY_EMAIL_FROM ||
    !validEmail(env.GUIDY_EMAIL_FROM) ||
    !validEmail(email) ||
    !/^\d{6}$/.test(otp)
  )
    throw new Error("Email not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
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
    if (!response.ok) throw new Error("Delivery rejected");
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("id" in result) ||
      typeof result.id !== "string" ||
      !result.id
    )
      throw new Error("Invalid delivery response");
  } catch {
    // Provider response bodies may contain addresses, credentials or message content.
    throw new Error("OTP email delivery failed");
  } finally {
    clearTimeout(timer);
  }
}
