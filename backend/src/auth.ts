import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { expo } from "@better-auth/expo";
import type { D1Database } from "@cloudflare/workers-types";
import { APIError } from "better-auth/api";
import {
  EmailDeliveryError,
  sendOtpEmail,
  validEmail,
  type EmailEnv,
} from "./email.ts";

export interface AuthEnv extends EmailEnv {
  DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GUIDY_AUTH_MODE?: string;
  GUIDY_EXPO_PREVIEW_ORIGINS?: string;
  GUIDY_ENVIRONMENT?: string;
}

function previewOrigins(env: AuthEnv): string[] {
  const value: unknown = JSON.parse(env.GUIDY_EXPO_PREVIEW_ORIGINS ?? "[]");
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    (value.length &&
      env.GUIDY_AUTH_MODE === "resend" &&
      env.GUIDY_ENVIRONMENT !== "development")
  )
    throw new Error("Invalid preview origins");
  return value.map((item: unknown) => {
    if (typeof item !== "string") throw new Error("Invalid preview origin");
    const url = new URL(item);
    if (
      url.protocol !== "exp:" ||
      !isLocalHost(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname)
    )
      throw new Error("Invalid preview origin");
    return `exp://${url.host}`;
  });
}

export function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

export function createAuth(env: AuthEnv, origins: string[] = []) {
  if (
    !env.DB ||
    !["local-inbox", "resend-test", "resend"].includes(
      env.GUIDY_AUTH_MODE ?? "",
    ) ||
    !env.BETTER_AUTH_SECRET ||
    env.BETTER_AUTH_SECRET.length < 32 ||
    !env.BETTER_AUTH_URL
  )
    throw new Error("Auth not configured");
  const base = new URL(env.BETTER_AUTH_URL);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid auth origin");
  if (env.GUIDY_AUTH_MODE === "local-inbox" && !isLocalHost(base.hostname))
    throw new Error("Local inbox only");
  if (!isLocalHost(base.hostname) && base.protocol !== "https:")
    throw new Error("HTTPS required");
  if (env.GUIDY_AUTH_MODE !== "local-inbox") {
    if (
      !env.RESEND_API_KEY ||
      !env.GUIDY_EMAIL_FROM ||
      !validEmail(env.GUIDY_EMAIL_FROM)
    )
      throw new Error("Email not configured");
    if (
      env.GUIDY_AUTH_MODE === "resend-test" &&
      (!env.GUIDY_EMAIL_TEST_TO ||
        !validEmail(env.GUIDY_EMAIL_TEST_TO) ||
        env.GUIDY_EMAIL_FROM !== "onboarding@resend.dev")
    )
      throw new Error("Test recipient not configured");
    if (
      env.GUIDY_AUTH_MODE === "resend" &&
      env.GUIDY_EMAIL_FROM.toLowerCase().endsWith("@resend.dev")
    )
      throw new Error("Verified sending domain required");
  }
  const db = env.DB;
  // Better Auth suppresses callback errors; the HTTP boundary must check delivery.
  const deliveryState: {
    status: "none" | "accepted" | "failed";
    code?: string;
  } = {
    status: "none",
  };
  const auth = betterAuth({
    appName: "Guidy",
    database: db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: base.origin,
    basePath: "/api/auth",
    trustedOrigins: [
      base.origin,
      "guidy://",
      ...origins,
      ...previewOrigins(env),
    ],
    logger: { disabled: true },
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const now = Date.now();
            await db
              .prepare(
                "INSERT INTO profiles (user_id,display_name,created_at,updated_at) VALUES (?, 'Guidy 用户', ?, ?) ON CONFLICT(user_id) DO NOTHING",
              )
              .bind(session.userId, now, now)
              .run();
            return { data: session };
          },
        },
      },
    },
    plugins: [
      expo(),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: "hashed",
        rateLimit: { window: 60, max: 3 },
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") throw new Error("Unsupported OTP purpose");
          if (env.GUIDY_AUTH_MODE !== "local-inbox") {
            if (
              env.GUIDY_AUTH_MODE === "resend-test" &&
              email.toLowerCase() !== env.GUIDY_EMAIL_TEST_TO?.toLowerCase()
            )
              throw new APIError("FORBIDDEN", {
                code: "TEST_RECIPIENT_ONLY",
                message: "当前仅支持已配置的测试收件邮箱。",
              });
            try {
              await sendOtpEmail(env, email, otp);
              deliveryState.status = "accepted";
            } catch (err) {
              deliveryState.status = "failed";
              deliveryState.code =
                err instanceof EmailDeliveryError
                  ? err.code
                  : "OTP_DELIVERY_FAILED";
              throw new APIError("BAD_GATEWAY", {
                code: "OTP_DELIVERY_FAILED",
                message: "验证码邮件发送失败，请稍后重试。",
              });
            }
            return;
          }
          const now = Date.now();
          await db.batch([
            db
              .prepare("DELETE FROM dev_auth_inbox WHERE expires_at <= ?")
              .bind(now),
            db
              .prepare(
                "INSERT INTO dev_auth_inbox(email,otp,expires_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET otp=excluded.otp,expires_at=excluded.expires_at",
              )
              .bind(email.toLowerCase(), otp, now + 300_000),
          ]);
          deliveryState.status = "accepted";
        },
      }),
    ],
  });
  return Object.assign(auth, { deliveryState });
}
