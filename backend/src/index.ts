export interface Env {
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
      const route = routes.find((entry) => entry.path === path);
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
            request.headers.get("Access-Control-Request-Method") !== "GET" ||
            requestedHeaders.some((h) => h !== "x-request-id")
          ) {
            response = error(id, 400, "CORS_REJECTED", "跨域请求未获允许。");
          } else {
            response = new Response(null, {
              status: 204,
              headers: {
                "Access-Control-Allow-Methods": "GET",
                "Access-Control-Allow-Headers": "X-Request-ID",
              },
            });
          }
        } else if (!route) {
          response = error(id, 404, "NOT_FOUND", "资源不存在。");
        } else if (request.method !== route.method) {
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
