import { planResponse } from "./agent/plan-service.ts";
import { createAuth, isLocalHost, type AuthEnv } from "./auth.ts";
import { goalsResponse } from "./goals.ts";
import { slotsResponse } from "./slots.ts";
import { researchResponse } from "./research/service.ts";
import { searchResponse } from "./research/search-service.ts";
import type { SearchEnv } from "./research/search-provider.ts";
import { jobResponse, type WorkflowBinding } from "./research/jobs.ts";
import { dialogueResponse } from "./agent/harness.ts";
import type { AgentEnv } from "./agent/provider.ts";

export interface Env extends AuthEnv, AgentEnv, SearchEnv {
  RESEARCH_WORKFLOW?: WorkflowBinding;
  GUIDY_CORS_ORIGINS?: string;
}
type RequestLog = {
  event: "request_completed";
  request_id: string;
  method: string;
  route: string;
  status_code: number;
  duration_ms: number;
};
type Route = {
  path: string;
  method: string;
  handle: (requestId: string) => Response | Promise<Response>;
};

const authPaths = new Map([
  ["/api/auth/email-otp/send-verification-otp", "POST"],
  ["/api/auth/sign-in/email-otp", "POST"],
  ["/api/auth/get-session", "GET"],
  ["/api/auth/sign-out", "POST"],
]);

async function authResponse(
  request: Request,
  env: Env,
  id: string,
  origins: string[],
): Promise<Response> {
  let auth: ReturnType<typeof createAuth>;
  try {
    auth = createAuth(env, origins);
    const incoming = new URL(request.url);
    const base = new URL(env.BETTER_AUTH_URL!);
    if (
      !(isLocalHost(incoming.hostname) && isLocalHost(base.hostname)) &&
      incoming.origin !== base.origin
    )
      throw new Error("Auth origin mismatch");
  } catch {
    return new URL(request.url).pathname.startsWith("/api/auth/")
      ? json(
          { code: "AUTH_NOT_CONFIGURED", message: "认证服务尚未配置。" },
          503,
        )
      : error(id, 503, "AUTH_NOT_CONFIGURED", "认证服务尚未配置。");
  }
  const path = new URL(request.url).pathname;
  if (
    path === "/api/v1/goals" ||
    /^\/api\/v1\/goals\/[0-9a-f-]{36}(?:\/(?:slots|messages|evidence|research-runs|search-runs|plan-drafts))?$/.test(
      path,
    )
  ) {
    const origin = request.headers.get("Origin");
    if (
      origin &&
      origin !== new URL(env.BETTER_AUTH_URL!).origin &&
      !origins.includes(origin)
    )
      return error(id, 403, "ORIGIN_REJECTED", "请求来源未获允许。");
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return error(id, 401, "UNAUTHORIZED", "请重新登录。");
    if (path.endsWith("/plan-drafts"))
      return planResponse(request, env.DB!, session.user.id, id, env);
    if (path.endsWith("/search-runs"))
      return searchResponse(request, env.DB!, session.user.id, id, env);
    if (path.endsWith("/research-runs"))
      return jobResponse(
        request,
        env.DB!,
        session.user.id,
        id,
        env.RESEARCH_WORKFLOW,
      );
    if (path.endsWith("/evidence"))
      return researchResponse(request, env.DB!, session.user.id, id);
    if (path.endsWith("/messages"))
      return dialogueResponse(request, env.DB!, session.user.id, id, env);
    return path.endsWith("/slots")
      ? slotsResponse(request, env.DB!, session.user.id, id)
      : goalsResponse(request, env.DB!, session.user.id, id);
  }
  if (path === "/api/v1/me") {
    if (request.method !== "GET")
      return error(id, 405, "METHOD_NOT_ALLOWED", "此接口不支持该请求方法。", {
        Allow: "GET",
      });
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return error(id, 401, "UNAUTHORIZED", "请重新登录。");
    const profile = await env
      .DB!.prepare(
        "SELECT display_name,locale,timezone FROM profiles WHERE user_id=?",
      )
      .bind(session.user.id)
      .first();
    return json({
      data: {
        id: session.user.id,
        email: session.user.email,
        name: profile?.display_name ?? session.user.name,
      },
      error: null,
      request_id: id,
    });
  }
  const method = authPaths.get(path);
  if (!method) return error(id, 404, "NOT_FOUND", "资源不存在。");
  if (request.method !== method)
    return error(id, 405, "METHOD_NOT_ALLOWED", "此接口不支持该请求方法。", {
      Allow: method,
    });
  let safeRequest = request;
  let email: string | undefined;
  if (request.method === "POST") {
    if (!request.headers.get("Content-Type")?.startsWith("application/json"))
      return error(id, 415, "INVALID_CONTENT_TYPE", "请使用 JSON 请求。");
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return error(id, 413, "BODY_TOO_LARGE", "请求内容过长。");
        }
        chunks.push(next.value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error();
    } catch {
      return error(id, 400, "INVALID_BODY", "请求格式不正确。");
    }
    if (path.endsWith("send-verification-otp") && body.type !== "sign-in")
      return error(id, 400, "INVALID_BODY", "仅支持登录验证码。");
    if (typeof body.email === "string") email = body.email.toLowerCase();
    if (
      env.GUIDY_AUTH_MODE === "resend-test" &&
      email &&
      email !== env.GUIDY_EMAIL_TEST_TO?.toLowerCase()
    )
      return json(
        {
          code: "TEST_RECIPIENT_ONLY",
          message: "当前仅支持已配置的测试收件邮箱。",
        },
        403,
      );
    safeRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bytes,
    });
  }
  const response = await auth.handler(safeRequest);
  if (
    path.endsWith("send-verification-otp") &&
    (auth.deliveryState.status === "failed" ||
      (response.ok && auth.deliveryState.status !== "accepted"))
  ) {
    return json(
      {
        code: auth.deliveryState.code ?? "OTP_DELIVERY_FAILED",
        message: "验证码发送未确认，请稍后重试。",
      },
      502,
    );
  }
  if (
    response.ok &&
    path.endsWith("sign-in/email-otp") &&
    email &&
    env.GUIDY_AUTH_MODE === "local-inbox"
  ) {
    await env
      .DB!.prepare("DELETE FROM dev_auth_inbox WHERE email=?")
      .bind(email)
      .run();
  }
  if (response.ok && path.endsWith("send-verification-otp")) {
    return json(
      {
        ...((await response.json()) as object),
        delivery:
          env.GUIDY_AUTH_MODE === "local-inbox" ? "local-inbox" : "email",
      },
      response.status,
      response.headers,
    );
  }
  // SDK endpoints keep Better Auth's wire protocol; never expose raw internal errors.
  if (!response.ok) {
    let code = "AUTH_FAILED";
    try {
      const value = (await response.json()) as { code?: string };
      if (value.code && /^[A-Z_]{1,80}$/.test(value.code)) code = value.code;
    } catch {
      /* Return a generic error even when the auth library body is malformed. */
    }
    return json(
      {
        code,
        message:
          response.status === 429
            ? "请求过于频繁，请稍后重试。"
            : "登录检查失败，请确认验证码或重新获取。",
      },
      response.status,
      { "Retry-After": response.headers.get("Retry-After") ?? "60" },
    );
  }
  return response;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const methods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
function requestId(value: string | null): string {
  return value && uuidPattern.test(value)
    ? value.toLowerCase()
    : crypto.randomUUID();
}
function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}
function error(
  id: string,
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): Response {
  return json(
    { data: null, error: { code, message, details: null }, request_id: id },
    status,
    headers,
  );
}
function corsOrigins(raw = "[]"): string[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("Invalid origins");
  return value.map((origin: unknown) => {
    if (typeof origin !== "string") throw new Error("Invalid origin");
    const url = new URL(origin);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Invalid origin");
    return url.origin;
  });
}

export function createApp({
  logger = (record: RequestLog) => console.log(JSON.stringify(record)),
  routes = [
    {
      path: "/health",
      method: "GET",
      handle: (id: string) =>
        json({
          data: { status: "ok", service: "guidy-api", version: "0.1.0" },
          error: null,
          request_id: id,
        }),
    },
  ],
}: { logger?: (record: RequestLog) => void; routes?: Route[] } = {}) {
  return {
    async fetch(request: Request, env: Env = {}): Promise<Response> {
      const id = requestId(request.headers.get("X-Request-ID"));
      const started = performance.now();
      const path = new URL(request.url).pathname;
      const isGoals =
        path === "/api/v1/goals" ||
        /^\/api\/v1\/goals\/[0-9a-f-]{36}(?:\/(?:slots|messages|evidence|research-runs|search-runs|plan-drafts))?$/.test(
          path,
        );
      const isAuth =
        path.startsWith("/api/auth/") || path === "/api/v1/me" || isGoals;
      const route = isAuth
        ? {
            path: isGoals
              ? path.endsWith("/plan-drafts")
                ? "/api/v1/goals/:id/plan-drafts"
                : path.endsWith("/search-runs")
                  ? "/api/v1/goals/:id/search-runs"
                  : path.endsWith("/research-runs")
                    ? "/api/v1/goals/:id/research-runs"
                    : path.endsWith("/evidence")
                      ? "/api/v1/goals/:id/evidence"
                      : path.endsWith("/messages")
                        ? "/api/v1/goals/:id/messages"
                        : path.endsWith("/slots")
                          ? "/api/v1/goals/:id/slots"
                          : "/api/v1/goals/:id?"
              : path === "/api/v1/me"
                ? path
                : "/api/auth/*",
            method: authPaths.get(path) ?? "GET",
            handle: (requestId: string) =>
              authResponse(
                request,
                env,
                requestId,
                corsOrigins(env.GUIDY_CORS_ORIGINS),
              ),
          }
        : routes.find((entry) => entry.path === path);
      const origin = request.headers.get("Origin");
      let response: Response;
      let allowed = false;
      try {
        allowed =
          origin !== null &&
          corsOrigins(env.GUIDY_CORS_ORIGINS).includes(origin);
        // Validate configuration even for native requests without an Origin header.
        if (!origin) corsOrigins(env.GUIDY_CORS_ORIGINS);
        if (
          request.method === "OPTIONS" &&
          request.headers.has("Access-Control-Request-Method")
        ) {
          const requestedHeaders =
            request.headers
              .get("Access-Control-Request-Headers")
              ?.split(",")
              .map((h) => h.trim().toLowerCase()) ?? [];
          if (
            !allowed ||
            !(
              isGoals
                ? ["GET", "POST", "PATCH"]
                : isAuth
                  ? ["GET", "POST"]
                  : ["GET"]
            ).includes(
              request.headers.get("Access-Control-Request-Method") ?? "",
            ) ||
            requestedHeaders.some(
              (h) =>
                !(
                  isAuth
                    ? [
                        "x-request-id",
                        "content-type",
                        "expo-origin",
                        ...(isGoals ? ["idempotency-key"] : []),
                      ]
                    : ["x-request-id"]
                ).includes(h),
            )
          ) {
            response = error(id, 400, "CORS_REJECTED", "跨域请求未获允许。");
          } else {
            response = new Response(null, {
              status: 204,
              headers: {
                "Access-Control-Allow-Methods": isGoals
                  ? "GET, POST, PATCH"
                  : isAuth
                    ? "GET, POST"
                    : "GET",
                "Access-Control-Allow-Headers": isAuth
                  ? `Content-Type, Expo-Origin, X-Request-ID${isGoals ? ", Idempotency-Key" : ""}`
                  : "X-Request-ID",
              },
            });
          }
        } else if (!route) {
          response = error(id, 404, "NOT_FOUND", "资源不存在。");
        } else if (!isAuth && request.method !== route.method) {
          response = error(
            id,
            405,
            "METHOD_NOT_ALLOWED",
            "此接口不支持该请求方法。",
            { Allow: route.method },
          );
        } else {
          response = await route.handle(id);
        }
      } catch {
        response = error(
          id,
          500,
          "INTERNAL_ERROR",
          "服务暂时不可用，请稍后重试。",
        );
      }
      const headers = new Headers(response.headers);
      headers.set("X-Request-ID", id);
      headers.set("Cache-Control", "no-store");
      headers.set("Vary", "Origin");
      if (allowed && origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Expose-Headers", "X-Request-ID");
        if (isAuth) headers.set("Access-Control-Allow-Credentials", "true");
      }
      const result = new Response(response.body, {
        status: response.status,
        headers,
      });
      logger({
        event: "request_completed",
        request_id: id,
        method: methods.has(request.method) ? request.method : "OTHER",
        route: route?.path ?? "unmatched",
        status_code: response.status,
        duration_ms: Math.round((performance.now() - started) * 100) / 100,
      });
      return result;
    },
  };
}

export default createApp();
