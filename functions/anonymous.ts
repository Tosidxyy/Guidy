import { sha256Hex } from './sse-app.ts';
import type { Deps, RouteCtx } from './types.ts';

// Plan B 匿名身份：平台不向未登录访客注入用户上下文，应用自签 HttpOnly cookie。
// visitor_id = SHA-256(token)：库与响应里只出现派生 id，cookie 凭证本身不落库。
export const ANON_COOKIE = '__Host-guidy_vid';
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGE_SECONDS = 34560000;

export function parseAnonToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== ANON_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (TOKEN_RE.test(value)) return value;
  }
  return null;
}

export function anonSetCookie(token: string): string {
  return `${ANON_COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export async function resolveIdentity(ctx: RouteCtx, requireUser: Deps['requireUser']): Promise<{ user: { id: string }; setCookie: string | null }> {
  try {
    const user = requireUser(ctx);
    if (user?.id) return { user: { id: user.id }, setCookie: null };
  } catch { /* 无平台身份（匿名访客或会话失效）→ 应用匿名身份，最小权限 */ }
  const token = parseAnonToken(ctx.request.headers.get('cookie'));
  if (token) return { user: { id: await sha256Hex(token) }, setCookie: null };
  const fresh = crypto.randomUUID();
  return { user: { id: await sha256Hex(fresh) }, setCookie: anonSetCookie(fresh) };
}