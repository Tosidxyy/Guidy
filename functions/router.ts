import { errorEnvelope, fail } from './errors.ts';
import type { Deps, RouteCtx } from './types.ts';
export interface Route { method: string; pattern: RegExp; handler: (ctx: RouteCtx, deps: Deps, params: string[]) => Promise<Response> | Response }
export function stripPrefix(url: string): string {
  const pathname = new URL(url).pathname;
  const m = pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
  if (!m) fail('not_found', 404);
  return m[1] || '/';
}
export async function readJson(request: Request, maxBytes: number): Promise<any> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail('invalid_input', 400);
  const reader = request.body?.getReader();
  if (!reader) fail('invalid_input', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail('payload_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('invalid_input', 400); }
}
export function createRouter(routes: Route[]) {
  return async (ctx: RouteCtx, deps: Deps): Promise<Response> => {
    const diagnosticId = crypto.randomUUID();
    try {
      const path = stripPrefix(ctx.request.url);
      let matched: Route | null = null; let params: string[] = [];
      for (const r of routes) {
        const m = path.match(r.pattern);
        if (m) { matched = r; params = m.slice(1); break; }
      }
      if (!matched) fail('not_found', 404);
      if (matched.method !== ctx.request.method) fail('method_not_allowed', 405);
      return await matched.handler(ctx, deps, params);
    } catch (error) {
      const { status, body } = errorEnvelope(error, diagnosticId);
      return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    }
  };
}