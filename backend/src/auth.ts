import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { expo } from "@better-auth/expo";
import type { D1Database } from "@cloudflare/workers-types";

export interface AuthEnv {
  DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GUIDY_AUTH_MODE?: string;
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
    env.GUIDY_AUTH_MODE !== "local-inbox" ||
    !env.BETTER_AUTH_SECRET ||
    env.BETTER_AUTH_SECRET.length < 32 ||
    !env.BETTER_AUTH_URL
  )
    throw new Error("Auth not configured");
  const base = new URL(env.BETTER_AUTH_URL);
  if (
    !isLocalHost(base.hostname) ||
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("Local auth only");
  const db = env.DB;
  return betterAuth({
    appName: "Guidy",
    database: db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: base.origin,
    basePath: "/api/auth",
    trustedOrigins: [base.origin, "guidy://", ...origins],
    logger: { disabled: true },
    advanced: { database: { generateId: "uuid" } },
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
        },
      }),
    ],
  });
}
