# Guidy M2 · AI 规划闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已开通的 Qoder Sites function_backend 上交付 M2 垂直切片——浏览器对话 → 同源 Deno Function → QCA Managed SSE → 约束确认卡 → 本地引擎预览 → 服务端权威 commit 落库 → 刷新恢复，站点保持 private。

**Architecture:** 单 `app` Edge Function（Deno）收敛路由/引擎重算/QCA 投影/配额/幂等；`application(deps)` 依赖注入，本地 vitest 与 `npx deno` 用 credential-free fake，部署用平台注入 SDK。前端 React SPA 新增 ChatPanel 左栏 + TanStack Query 服务端状态 + Zustand 流式态；引擎双端运行（前端预览、服务端 commit 重算比对 result_hash）。

**Tech Stack:** Deno (npm devDep) · `npm:zod@3` · 平台注入 `_qoder/backend.mjs`（createDatabaseClient/createSiteContext/requireUser/errorResponse/BackendError）· vendored `cloud-agents.mjs`/`sse.mjs`/`conversation-stream.mjs` · React 19 + Vite 8 + Tailwind 4 + shadcn · @tanstack/react-query v5 · zustand v5 · react-markdown + rehype-sanitize · date-fns 4 / date-fns-tz 3 · Vitest 5。

**Spec:** [docs/superpowers/specs/2026-11-16-m2-ai-planning-design.md](../specs/2026-11-16-m2-ai-planning-design.md)

## Global Constraints

- 平台硬边界：静态 SPA（`dist/index.html`，`prepare_site.spa:true`）；单 `app` Function（`functions/index.ts`，`Deno.serve`）；Function 依赖自包含（vendored `.mjs` + `npm:` 说明符，部署不装 npm）；持久化走 function_backend Postgres `app` schema + reviewed migration；身份 `requireUser(ctx)`；AI 走 QCA Managed SSE，`QODER_PAT` 仅 Function 内 `Deno.env.get('QODER_PAT')`。
- `QODER_PAT` 平台托管：不进 `prepare_site.secretNames`、不下发浏览器、不入日志、不用普通 Secret 工具写、不伪造。缺失/无效 → 安全服务错误，不 mint 新 token。
- M2 站点保持 **private**（`access_mode: private`）；public 属 M4，未经显式授权不得 public 发布。
- 错误包络 `{error:{code,message,diagnostic_id,details?}}`；message 可读中文；diagnostic_id 不含凭据/原文/签名 URL。
- 前置顺序：方法/大小/归属 → 配额 → 并发 → 才触上游。写操作全部参数化（SDK builder `.eq`），归属 WHERE 带 `owner_visitor_id=$verified`，跨访客 403。
- 输入上限：消息 ≤2000 字符；task_defs ≤30 / blocks ≤300 / constraints ≤40；clarifications_needed ≤2；artifact 校验重试 ≤2。
- 配额：chat 60 轮/访客/日；并发 pending 派发 ≤1/访客。`ENGINE_VERSION=1`（shared/constants.ts）。
- 时间全 UTC ISO-8601 传输/存储；`HH:mm` 按计划时区解释；日期 `YYYY-MM-dd`。
- 无通用事务 → 唯一键幂等（commit_log.preview_id / dispatch_intents.request_id）+ `plans.version` 条件更新 + 失败对账；结果未知保持 pending，不自动重发写。
- XSS：react-markdown + rehype-sanitize 白名单禁 raw HTML；模板/对话文本同等待遇。
- 验收分离报告：本地 fixture / 站点发布 / 真实 AI 执行 三者分开；ready backend / HTTP 200 ≠ AI 验收。未验证项明确标注。
- 引擎/Schema 单一来源 `shared/`；前端 Vite alias `@`，Function 相对路径 + deno.json import map。M1 既有 33 例（engine 23 + schema 10）必须保持全绿。
- 提交粒度：每 Task 末尾 commit；不 push（用户未授权）；不 amend。

## 平台约束导致的 Spec 偏差（已核实，执行时遵守）

1. **迁移 SQL 受限子集**（sites-building/references/database-migration.md）：仅支持 `CREATE TABLE app.<t>` / `ALTER TABLE ADD COLUMN` /  plain `CREATE INDEX`；列类型仅 `boolean/integer/bigint/text/uuid/timestamptz/jsonb`；**不支持 `CHECK`、`date`、`text[]`、partial index（WHERE）、index 的 ASC/DESC、CREATE SCHEMA、自定义函数/触发器**。因此契约 §3 DDL 必须改写：`date`→`text`（Function 内校验 YYYY-MM-dd）；删除所有 `CHECK`（校验移入 Zod/Function）；partial index 改 plain index；`created_at DESC` 改 plain `created_at`；省略 `CREATE SCHEMA`（平台提供 app schema）。FK `REFERENCES app.<t>(id)` 受支持但 `ON DELETE` 动作需以工具返回的 normalized SQL/校验为准——若被拒则去掉 ON DELETE 动作并在 Function 内做软删/级联清理。
2. **新增第 10 张表 `cloud_bindings`**：QCA Agent/Environment/Session 资源协调需要持久 lease/binding（initialization.md 要求 durable coordinator）。Spec §4 列 9 表未含此表；本计划补 `cloud_bindings`（key text PK / state / resource_id / version / fingerprint / lease_token / updated_at）。
3. **本地 Deno 类型 gate 目标 = `functions/app.ts`**（平台无关）：`functions/index.ts` 导入注入模块 `./_qoder/backend.mjs`，本地禁止创建 `functions/_qoder`（packager 拒绝），故 index.ts 仅在部署运行时解析。本地 `npx deno check functions/app.ts`；index.ts 于部署后实测验证。
4. **DB SDK 形态 = function_backend builder**（records 示例权威）：`db.from(t).select(cols).eq(k,v).order(k,{ascending}).limit(n).insert(v).insertIfAbsent(v,{onConflict}).update(v).delete()` → thenable `{data,error}`；`requireUser(ctx)`→`{id}`；`BackendError(code,status)`。非 legacy supabase `.single()/.maybeSingle()`。

## 已开通云资源（复用，勿重复初始化）

- project `01a1e421-fb6e-756e-a7c8-44fd5a28b23f` · site `01a1e421-fb71-7745-9db4-db763e874017`
- host `guidy-oxg3oo3dpdz.qoder.zone`（private、hasPublishedContent:false）
- backend ready：database/functions/qoder/storage；`database_access_model: function_backend`；PAT 已 issue+sync（平台托管）
- QCA origin `https://api.qoder.com.cn`，prefix `/api/v1/cloud`
- 空库 schemaRef（迁移前读取，Task 10 重新读取最新值）：`sr_NYa-cTQkV1H5tw4K-wXS8giiC0sc5A4AoFZoCBhIM-qNgz_v5LpOURALiAI0dxMwc1WJRHH4IbxaE661ND7UX7DPx8Gdx5ySs0OfSVlyI9COkDZbbq5x0n6bj6ZCC-4mc1rz8Uw-q4RftVFA_5VEvTf22CYvXiJJ0_G_KAU7MYSENGbQ_e4B6THMihJuQibXm_z2W5QsWKm5_CQveUhWKoledZz_q1OTG64ErWTeOXQwqsNRlCpsp7UJoAPsReclQAtIYH93GH50zvbLN6o17VQeeRilZHVjF2YVkPz5UOnPNn-GnH2kxTq4bptesw`
- backendRef `sr_NmX_Fpu_D2EYCYC2nbp3ZeQg3TF1xa8A-jkbpV7cYCHMVhh98AKD6hc16_ONkAE93lnKb5f3Of-5YUMNKbhv1aJLENls4OljV1HAnjoBKT01jk47oE8jKHAyZRU`

## File Structure

**后端（functions/，部署包；dev/ 与 deno.json 不进包）**
- `functions/index.ts` — Deno.serve + createSiteContext + 注入 SDK → application(deps)（部署入口，导入 `_qoder/backend.mjs`）
- `functions/app.ts` — `application(deps)`：组装 router，平台无关（本地 deno check 目标）
- `functions/router.ts` — 剥离前缀、方法/大小前置、错误包络边界、diagnostic_id
- `functions/errors.ts` — `BackendError` 复用 + `fail(code,status,details?)` + 错误码→中文 message 表
- `functions/identity.ts` — `requireVisitor(deps,ctx)`→visitor_id
- `functions/db.ts` — `rows(result)` 解包 + 错误翻译；DB builder 类型 `Db`/`DbQuery`
- `functions/quotas.ts` — `incrementChatTurn` CAS + `assertNoPendingDispatch`
- `functions/schemas.ts` — re-export shared/schemas（npm:zod）+ `validateArtifact`
- `functions/engine/index.ts` — re-export shared/engine
- `functions/prompt.ts` — 固定系统指令 + `buildUserPrompt`
- `functions/types.ts` — `Deps`/`QcaAdapter`/`AppEvent`/`RouteCtx` 接口
- `functions/routes/{health,me,conversations,chat,plans}.ts`
- `functions/qca/cloud-agents.mjs` · `sse.mjs` — vendored 官方资产（不改）
- `functions/qca/coordinator.ts` — DB-backed `withLock` durable coordinator
- `functions/qca/sessions.ts` — visitor→conversation→qca_session 懒初始化
- `functions/qca/dispatch.ts` — request_id 幂等派发 + pending 对账 + artifact 重试 ≤2
- `functions/qca/project.ts` — 上游帧→白名单 AppEvent 投影 + messages/游标持久化
- `functions/qca/live.ts` — 真实 QcaAdapter（createCloudAgentsClient + ensureCloudResources）
- `deno.json` — import map（zod/date-fns/date-fns-tz）
- `dev/fake-db.ts` — createMemoryDb（builder 形态）
- `dev/fake-qca.ts` — createFakeQca（计数、可控超时/产物）
- `dev/function-local.ts` — npx deno 本地入口（fake deps，127.0.0.1:8000）
- `functions/__tests__/routes.test.ts` — vitest application(fakeDeps) 路由/投影/协调测试

**前端（新增/修改）**
- `lib/api.ts` — fetch 封装：错误包络、diagnostic_id、409/422/429 语义
- `lib/vendor/sse.mjs` · `conversation-stream.mjs` — vendored 浏览器 SSE 助手
- `lib/sse.ts` — send POST 流消费 + events GET 重连（cursor）
- `store/useChatStore.ts` — conversation_id/消息缓冲/流式态/cursor/连接态
- `components/chat/{ChatPanel,MessageBubble,StreamingCursor,ConstraintConfirmCard,ChatInput}.tsx`
- `src/main.tsx` — QueryClientProvider
- `src/App.tsx` — ChatPanel 左栏 + 日历右栏 + 移动 Tab 对话/日历
- `components/workbench/TopBar.tsx` — 紧凑计划头（统计/约束/任务入口）
- `package.json` — 新增依赖 + dev:function 改 npx deno

---

### Task 1: 依赖、vendored 资产、Deno import map 与平台无关骨架（/health）

**Files:**
- Modify: `package.json`（dependencies + devDependencies + scripts）
- Create: `deno.json`
- Create: `functions/qca/cloud-agents.mjs`、`functions/qca/sse.mjs`（vendored 复制）
- Create: `lib/vendor/sse.mjs`、`lib/vendor/conversation-stream.mjs`（vendored 复制）
- Create: `functions/errors.ts`、`functions/types.ts`、`functions/db.ts`、`functions/router.ts`、`functions/app.ts`、`functions/routes/health.ts`
- Create: `dev/fake-qca.ts`
- Test: `functions/__tests__/routes.test.ts`

**Interfaces:**
- Produces: `AppError(code,status,details?)`；`fail(code,status?,details?)`；`errorEnvelope(error,diagnosticId)`；`MESSAGES`
- Produces: `Db`/`DbQuery`（builder 形态）、`rows<T>(result)`
- Produces: `Deps{db,requireUser,qca,config,now?}`、`QcaAdapter`、`RouteCtx{request,user?,requestId?}`、`AppEvent`
- Produces: `application(deps): (ctx:RouteCtx)=>Promise<Response>`；`readJson(request,maxBytes)`；`stripPrefix(url)`
- Produces: `createFakeQca(overrides?)`（Task 5/7 扩展）

- [ ] **Step 1: 安装依赖**

Run:
```bash
npm install @tanstack/react-query@^5 react-markdown@^9 rehype-sanitize@^6
npm install -D deno@^2
```
Expected: 安装成功；`node_modules/.bin/deno` 存在。不系统级安装 Deno。

- [ ] **Step 2: 复制 vendored 官方资产（逐字，不改）**

Run（Git Bash，源为 Sites 插件资产目录）:
```bash
SRC="/e/Qoder CN/resources/extensions/qoder.sites/dist/plugin/skills/sites-build-agent-app/assets"
mkdir -p functions/qca lib/vendor
cp "$SRC/cloud-agents.mjs" functions/qca/cloud-agents.mjs
cp "$SRC/sse.mjs" functions/qca/sse.mjs
cp "$SRC/sse.mjs" lib/vendor/sse.mjs
cp "$SRC/conversation-stream.mjs" lib/vendor/conversation-stream.mjs
```
Expected: 四个文件存在；内容与源一致（`diff` 为空）。这些是传输助手，不是完整会话服务。

- [ ] **Step 3: 写 `deno.json` import map**

```json
{
  "imports": {
    "zod": "npm:zod@3.25.76",
    "date-fns": "npm:date-fns@4.4.0",
    "date-fns-tz": "npm:date-fns-tz@3.2.0",
    "@/": "./"
  }
}
```

- [ ] **Step 4: 更新 `package.json` scripts**

将 `dev:function` 与 `check:function` 改为：
```json
"dev:function": "npx deno run --allow-net=127.0.0.1:8000 --allow-read --allow-env dev/function-local.ts",
"check:function": "npx deno check functions/app.ts"
```
（local gate 目标 app.ts，平台无关；index.ts 部署验证。见 Spec 偏差 3。）

- [ ] **Step 5: 写 `functions/errors.ts`**

```ts
export class AppError extends Error {
  code: string; status: number; details?: unknown;
  constructor(code: string, status: number, details?: unknown) {
    super(code); this.code = code; this.status = status; this.details = details;
  }
}
export const MESSAGES: Record<string, string> = {
  unauthorized: '身份缺失或已失效，请刷新页面重建匿名身份',
  forbidden: '无权访问该资源',
  not_found: '资源不存在或已删除',
  validation_failed: '输入校验失败，请检查后重试',
  placement_invalid: '落点违反硬约束',
  engine_infeasible: '当前约束下无法排下全部任务',
  content_rejected: '内容审核未通过',
  artifact_invalid: 'AI 产出结构不合格，已保留上下文，请重试',
  quota_exceeded: '今日对话额度已用完，请明天再来',
  dispatch_busy: '当前有正在生成的回复，请等待或中断后再发送',
  version_conflict: '计划已被更新，请刷新后重试',
  engine_version_mismatch: '排程引擎版本不一致，请刷新页面',
  upstream_error: 'AI 服务暂时失败，请稍后重试',
  service_unavailable: '后端尚未就绪，请稍后重试',
  payload_too_large: '消息过长，请精简后重试',
  method_not_allowed: '请求方法不被允许',
  invalid_input: '请求格式不正确',
};
export function fail(code: string, status: number, details?: unknown): never {
  throw new AppError(code, status, details);
}
export function errorEnvelope(error: unknown, diagnosticId: string) {
  const code = (error as AppError)?.code ?? 'service_unavailable';
  const status = (error as AppError)?.status ?? 503;
  const known = MESSAGES[code] ? code : 'service_unavailable';
  return {
    status: (error as AppError)?.status ?? 503,
    body: { error: { code: known, message: MESSAGES[known], diagnostic_id: diagnosticId,
      ...((error as AppError)?.details !== undefined ? { details: (error as AppError).details } : {}) } },
  };
}
```

- [ ] **Step 6: 写 `functions/db.ts`（builder 类型 + 解包）**

```ts
import { fail } from './errors';
export interface DbQuery extends PromiseLike<{ data: any[] | null; error: { code: string; status: number } | null }> {
  select(cols?: string): DbQuery;
  eq(col: string, val: unknown): DbQuery;
  order(col: string, opts?: { ascending?: boolean }): DbQuery;
  limit(n: number): DbQuery;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): DbQuery;
  insertIfAbsent(values: Record<string, unknown>, opts: { onConflict: string }): DbQuery;
  update(values: Record<string, unknown>): DbQuery;
  delete(): DbQuery;
}
export interface Db { from(table: string): DbQuery }
export function rows<T = any>(result: { data: T[] | null; error: { code: string; status: number } | null }): T[] {
  if (result.error) fail(result.error.code === 'database_not_configured' ? 'service_unavailable' : 'upstream_error',
    result.error.status >= 400 && result.error.status < 500 ? result.error.status : 503);
  return result.data ?? [];
}
```

- [ ] **Step 7: 写 `functions/types.ts`**

```ts
import type { Db } from './db';
export interface RouteCtx { request: Request; user?: { id: string } | null; requestId?: string }
export interface QcaBinding { agent: { type: 'agent'; id: string; version: number }; environment_id: string }
export interface QcaAdapter {
  ensureBinding(scope: string): Promise<QcaBinding>;
  createSession(binding: QcaBinding, title: string, metadata: Record<string, string>): Promise<{ id: string }>;
  sendEvents(sessionId: string, text: string, idempotencyKey: string): Promise<{ eventIds: string[] }>;
  openStream(sessionId: string, opts: { lastEventId?: string; signal?: AbortSignal }): Promise<{ body: ReadableStream<Uint8Array>; close(): void }>;
  listEvents(sessionId: string, opts: { order?: 'asc' | 'desc'; limit?: number }): Promise<{ data: any[]; has_more: boolean; next_page?: string }>;
}
export interface Deps {
  db: Db;
  requireUser: (ctx: RouteCtx) => { id: string };
  qca: QcaAdapter;
  config: { cloudApiOrigin: string; appScope: string; modelId: string };
  now?: () => Date;
}
export type AppEvent =
  | { event: 'accepted'; data: { request_id: string; conversation_id: string; seq: number } }
  | { event: 'delta'; data: { seq: number; text: string } }
  | { event: 'artifact'; data: { seq: number; kind: 'constraint_set' | 'patch'; payload: unknown } }
  | { event: 'status'; data: { seq: number; state: 'running' | 'waiting_confirm' | 'completed' | 'interrupted' | 'failed' } }
  | { event: 'error'; data: { seq: number; code: string; message: string; diagnostic_id: string } }
  | { event: 'done'; data: { seq: number } };
```

- [ ] **Step 8: 写 `functions/router.ts`**

```ts
import { AppError, errorEnvelope, fail } from './errors';
import type { Deps, RouteCtx } from './types';
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
```

- [ ] **Step 9: 写 `functions/routes/health.ts` 与 `functions/app.ts`**

`functions/routes/health.ts`:
```ts
import { ENGINE_VERSION } from '../../shared/constants';
import type { Deps, RouteCtx } from '../types';
export function health(_ctx: RouteCtx, _deps: Deps): Response {
  return Response.json({ ok: true, engine_version: ENGINE_VERSION }, { headers: { 'cache-control': 'no-store' } });
}
```
`functions/app.ts`:
```ts
import { createRouter, type Route } from './router';
import type { Deps, RouteCtx } from './types';
import { health } from './routes/health';
export function application(deps: Deps) {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: health },
  ];
  const router = createRouter(routes);
  return (ctx: RouteCtx) => router(ctx, deps);
}
```

- [ ] **Step 10: 写 `dev/fake-qca.ts`（最小桩，Task 5/7 扩展）**

```ts
import type { QcaAdapter } from '../functions/types';
export function createFakeQca(overrides: Partial<QcaAdapter> = {}): QcaAdapter {
  return {
    async ensureBinding() { return { agent: { type: 'agent', id: 'agent_fake', version: 1 }, environment_id: 'env_fake' }; },
    async createSession() { return { id: 'sess_fake' }; },
    async sendEvents() { return { eventIds: ['evt_fake'] }; },
    async openStream() { return { body: new ReadableStream({ start(c) { c.close(); } }), close() {} }; },
    async listEvents() { return { data: [], has_more: false }; },
    ...overrides,
  };
}
```

- [ ] **Step 11: 写失败测试 `functions/__tests__/routes.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { application } from '../app';
import type { Deps, RouteCtx } from '../types';
import { createFakeQca } from '../../dev/fake-qca';
function deps(): Deps {
  return { db: {} as any, requireUser: (ctx) => { if (!ctx.user) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); return ctx.user; },
    qca: createFakeQca(), config: { cloudApiOrigin: 'https://api.qoder.com.cn', appScope: 'guidy-test', modelId: 'model-fake' } };
}
function ctx(method: string, path: string, user: { id: string } | null = { id: 'visitor-a' }): RouteCtx {
  return { request: new Request(`http://127.0.0.1:8000/functions/v1/app${path}`, { method }), user };
}
describe('router skeleton', () => {
  it('R4: GET /api/health 匿名 200 + engine_version', async () => {
    const res = await application(deps())(ctx('GET', '/api/health', null));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, engine_version: 1 });
  });
  it('未知路径 404 包络', async () => {
    const res = await application(deps())(ctx('GET', '/api/nope'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.diagnostic_id).toBeTruthy();
  });
  it('错误方法 405', async () => {
    const res = await application(deps())(ctx('POST', '/api/health'));
    expect(res.status).toBe(405);
  });
});
```

- [ ] **Step 12: 运行测试确认失败→通过**

Run: `npx vitest run functions/__tests__/routes.test.ts`
Expected: 先因模块缺失 FAIL；实现后 PASS（3 例）。

- [ ] **Step 13: Deno 类型 gate + 前端构建 + 全量单测**

Run:
```bash
npx deno check functions/app.ts
npm run build
npx vitest run
```
Expected: deno check 通过（T2 首验：npm:zod/date-fns 解析成功）；build 通过；既有 33 例 + 新 3 例全绿。若 deno check 因 npm 解析失败 → 记录 T2，按 Spec 风险预案 vendor zod（后续 Task 处理），不静默跳过。

- [ ] **Step 14: Commit**

```bash
git add package.json package-lock.json deno.json functions lib/vendor dev/fake-qca.ts
git commit -m "feat(m2): platform-free function skeleton, vendored QCA assets, deno import map"
```

---

### Task 2: 内存 DB fake、身份、配额 CAS 与 /me

**Files:**
- Create: `dev/fake-db.ts`、`functions/identity.ts`、`functions/quotas.ts`、`functions/routes/me.ts`
- Modify: `functions/app.ts`（注册 /api/me）
- Test: `functions/__tests__/routes.test.ts`（追加）

**Interfaces:**
- Consumes: `Db`/`DbQuery`/`rows`（Task 1）、`Deps`/`RouteCtx`、`fail`
- Produces: `createMemoryDb(seed?)`（builder 形态，含 tables/reset）；`requireVisitor(deps,ctx):string`；`incrementChatTurn(db,visitor,day,limit):Promise<number>`（返回剩余，超限抛 quota_exceeded）；`todayStr(now,tz?)`；`me` handler

- [ ] **Step 1: 写 `dev/fake-db.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Db, DbQuery } from '../functions/db';
const ID_TABLES = new Set(['plans', 'task_defs', 'constraints', 'blocks', 'conversations', 'messages', 'template_uses', 'recovery_codes']);
const TS_TABLES = new Set(['plans', 'conversations', 'messages', 'dispatch_intents', 'commit_log', 'cloud_bindings', 'constraints', 'blocks', 'task_defs']);
export interface MemoryDb extends Db { tables: Record<string, any[]>; reset(): void }
export function createMemoryDb(seed: Record<string, any[]> = {}): MemoryDb {
  const tables: Record<string, any[]> = {};
  const reset = () => { for (const k of Object.keys(tables)) delete tables[k]; for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r })); };
  reset();
  const ensure = (t: string) => (tables[t] ??= []);
  return {
    tables, reset,
    from(table: string): DbQuery {
      const rowsRef = ensure(table);
      const filters: [string, unknown][] = []; const order: [string, boolean][] = [];
      let mode: 'read' | 'insert' | 'update' | 'delete' = 'read';
      let values: any; let conflict: string[] | null = null; let columns: string | null = null; let count = 1000;
      const project = (row: any) => columns ? Object.fromEntries(columns.split(',').map((c) => [c.trim(), row[c.trim()]])) : { ...row };
      const q: DbQuery = {
        select(cols) { columns = cols ?? null; return q; },
        eq(k, v) { filters.push([k, v]); return q; },
        order(k, o) { order.push([k, o?.ascending !== false]); return q; },
        limit(n) { count = n; return q; },
        insert(v) { mode = 'insert'; values = v; return q; },
        insertIfAbsent(v, o) { mode = 'insert'; values = v; conflict = o.onConflict.split(','); return q; },
        update(v) { mode = 'update'; values = v; return q; },
        delete() { mode = 'delete'; return q; },
        then(onF, onR) {
          return Promise.resolve().then(() => {
            let result: any[];
            const match = (row: any) => filters.every(([k, v]) => row[k] === v);
            if (mode === 'insert') {
              const list = Array.isArray(values) ? values : [values];
              result = [];
              for (const v of list) {
                if (conflict && rowsRef.some((row) => conflict!.every((k) => row[k] === v[k]))) continue;
                const row = { ...v };
                if (ID_TABLES.has(table) && row.id === undefined) row.id = randomUUID();
                if (TS_TABLES.has(table)) { row.created_at ??= new Date().toISOString(); if ('updated_at' in row || table === 'plans' || table === 'conversations') row.updated_at ??= new Date().toISOString(); }
                rowsRef.push(row); result.push(row);
              }
            } else {
              result = rowsRef.filter(match);
              if (mode === 'update') result.forEach((row) => Object.assign(row, values));
              if (mode === 'delete') { for (const row of result) rowsRef.splice(rowsRef.indexOf(row), 1); }
            }
            for (const [k, asc] of [...order].reverse()) result = [...result].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
            return { data: result.slice(0, count).map(project), error: null };
          }).then(onF as any, onR as any);
        },
      };
      return q;
    },
  };
}
```

- [ ] **Step 2: 写 `functions/identity.ts`**

```ts
import { fail } from './errors';
import type { Deps, RouteCtx } from './types';
export function requireVisitor(deps: Deps, ctx: RouteCtx): string {
  try { return deps.requireUser(ctx).id; }
  catch { fail('unauthorized', 401); }
}
```

- [ ] **Step 3: 写 `functions/quotas.ts`**

```ts
import { rows } from './db';
import type { Db } from './db';
import { fail } from './errors';
import { QUOTAS } from '../../shared/constants';
export function todayStr(now: Date): string { return now.toISOString().slice(0, 10); }
export async function incrementChatTurn(db: Db, visitor: string, day: string, limit = QUOTAS.chatTurnsPerDay): Promise<number> {
  rows(await db.from('quotas').insertIfAbsent({ visitor_id: visitor, day, chat_turns: 0, publishes: 0 }, { onConflict: 'visitor_id,day' }));
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = rows(await db.from('quotas').select('chat_turns').eq('visitor_id', visitor).eq('day', day).limit(1))[0]?.chat_turns ?? 0;
    if (current >= limit) fail('quota_exceeded', 429, { limit });
    const updated = rows(await db.from('quotas').update({ chat_turns: current + 1 }).eq('visitor_id', visitor).eq('day', day).eq('chat_turns', current).select('chat_turns'));
    if (updated.length) return limit - (current + 1);
  }
  fail('service_unavailable', 503);
}
export async function assertNoPendingDispatch(db: Db, visitor: string): Promise<void> {
  const pending = rows(await db.from('dispatch_intents').select('request_id').eq('visitor_id', visitor).eq('status', 'pending').limit(1));
  if (pending.length) fail('dispatch_busy', 409);
}
```

- [ ] **Step 4: 写 `functions/routes/me.ts`**

```ts
import { rows } from '../db';
import { requireVisitor } from '../identity';
import { todayStr } from '../quotas';
import { QUOTAS } from '../../shared/constants';
import type { Deps, RouteCtx } from '../types';
export async function me(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const day = todayStr(deps.now?.() ?? new Date());
  const q = rows(await deps.db.from('quotas').select('chat_turns,publishes').eq('visitor_id', visitor).eq('day', day).limit(1))[0];
  return Response.json({
    visitor_id: visitor,
    quotas: { chat_remaining: QUOTAS.chatTurnsPerDay - (q?.chat_turns ?? 0), publish_remaining: QUOTAS.publishesPerDay - (q?.publishes ?? 0) },
    has_recovery_code: false,
  }, { headers: { 'cache-control': 'no-store' } });
}
```

- [ ] **Step 5: 注册 /api/me 到 `functions/app.ts`**

在 routes 数组追加：
```ts
import { me } from './routes/me';
// ...
{ method: 'GET', pattern: /^\/api\/me$/, handler: me },
```

- [ ] **Step 6: 追加失败测试**

追加到 `functions/__tests__/routes.test.ts`（更新 deps() 使用 createMemoryDb）：
```ts
import { createMemoryDb } from '../../dev/fake-db';
// deps() 中 db 改为 createMemoryDb()
describe('identity + quotas + me', () => {
  it('R3: 无身份 /api/me → 401', async () => {
    const res = await application(deps())(ctx('GET', '/api/me', null));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
  });
  it('GET /api/me 返回 visitor_id 与满额配额', async () => {
    const res = await application(deps())(ctx('GET', '/api/me'));
    const body = await res.json();
    expect(body.visitor_id).toBe('visitor-a');
    expect(body.quotas.chat_remaining).toBe(60);
  });
  it('R13: incrementChatTurn 第 61 次抛 quota_exceeded，上游零调用', async () => {
    const { incrementChatTurn } = await import('../quotas');
    const db = createMemoryDb();
    for (let i = 0; i < 60; i++) await incrementChatTurn(db, 'v', '2026-11-16');
    await expect(incrementChatTurn(db, 'v', '2026-11-16')).rejects.toMatchObject({ code: 'quota_exceeded', status: 429 });
  });
});
```

- [ ] **Step 7: 运行测试 + deno check**

Run: `npx vitest run functions/__tests__/routes.test.ts && npx deno check functions/app.ts`
Expected: 全绿（含 R3/R13）。

- [ ] **Step 8: Commit**

```bash
git add dev/fake-db.ts functions/identity.ts functions/quotas.ts functions/routes/me.ts functions/app.ts functions/__tests__/routes.test.ts
git commit -m "feat(m2): memory db fake, visitor identity, quota CAS, /me route"
```

---

### Task 3: 系统提示词、模型产物解析与引擎再导出

**Files:**
- Create: `functions/prompt.ts`、`functions/artifacts.ts`、`functions/engine.ts`
- Test: `functions/__tests__/artifacts.test.ts`

**Interfaces:**
- Consumes: `ConstraintSetArtifactSchema`/`PatchArtifactSchema`（`shared/schemas.ts`，已存在）、`PlanState`（`shared/types`）、引擎（`shared/engine`）
- Produces: `buildSystemPrompt():string`；`buildUserMessage(input:{message:string; plan:PlanState|null; history:{role:string;content:string}[]}):string`；`parseModelText(text):ParsedArtifact|null`（`ParsedArtifact = {kind:'constraint_set';value:ConstraintSetArtifact} | {kind:'patch';value:PatchArtifact}`）；`functions/engine.ts` 再导出 `solve/validatePlacement/diffBlocks/resultHash`

- [ ] **Step 1: 写 `functions/engine.ts`**

```ts
export { solve, validatePlacement, diffBlocks, resultHash } from '../../shared/engine';
```

- [ ] **Step 2: 写 `functions/prompt.ts`**

```ts
import type { PlanState } from '../shared/types';
import { taskSummary, constraintText } from '../lib/describe';
export function buildSystemPrompt(): string {
  return [
    '你是 Guidy 的排程助手。根据用户的自然语言目标，产出可被确定性引擎消费的结构化约束。',
    '只输出一个 JSON 对象（可用 ```json 代码块包裹），type 为 constraint_set 或 patch：',
    '- constraint_set：{type:"constraint_set",plan_title,horizon_days:7|14,task_defs:[...],constraints:[...],clarifications_needed:[...]}。task_defs 每项 {key,title,category,duration_min,frequency,priority?,splittable?,preferred_period?,sort_order?}，category ∈ study/fitness/reading/work/life/creative/rest/other；constraints 每项是 payload 对象 {type:...}（不含 id），type ∈ busy_window/active_window/daily_cap/mutex/preferred_period/buffer/fixed_block/deadline。',
    '- patch：用户要求修改已有计划时输出 {type:"patch",summary,ops:[...]}，ops 为 add_task_def/update_task_def/remove_task_def/add_constraint/update_constraint/remove_constraint/add_block/update_block/move_block/remove_block/reschedule。',
    '信息不足时最多提出 2 个澄清问题（clarifications_needed），不要臆造用户未给出的硬性时间。',
    '所有时间用 HH:mm 本地时区；duration_min 为 5–480 的整数；key 仅小写字母数字下划线（1–24 位）。',
    '不要输出 JSON 以外的解释性文字作为产物；普通对话回复可直接用自然语言。',
  ].join('\n');
}
export function buildUserMessage(input: { message: string; plan: PlanState | null; history: { role: string; content: string }[] }): string {
  const lines: string[] = [];
  if (input.plan) {
    lines.push(`当前计划「${input.plan.plan.title}」，horizon_start=${input.plan.plan.horizon_start}，timezone=${input.plan.plan.timezone}。`);
    lines.push('任务：' + input.plan.task_defs.map((t) => `${t.title}（${taskSummary(t)}）`).join('；'));
    lines.push('约束：' + (input.plan.constraints.map((c) => constraintText(c.payload)).join('；') || '无'));
    lines.push(`已有 ${input.plan.blocks.length} 个时间块。`);
  } else {
    lines.push('当前没有计划，请生成 constraint_set。');
  }
  for (const h of input.history.slice(-6)) lines.push(`${h.role}: ${h.content}`);
  lines.push(`user: ${input.message}`);
  return lines.join('\n');
}
```
`taskSummary(t:TaskDef)` 与 `constraintText(p:ConstraintPayload)` 来自 `lib/describe.ts`（已存在，纯函数）。`lib/describe.ts` 用 `@/shared/...` 别名导入；Deno 侧需在 `deno.json` imports 增加 `"@/": "./"`（Task 1 的 import map 追加此项），使 Deno 能解析该别名。

- [ ] **Step 3: 写 `functions/artifacts.ts`**

```ts
import { ConstraintSetArtifactSchema, PatchArtifactSchema } from '../../shared/schemas';
import type { ConstraintSetArtifact, PatchArtifact } from '../../shared/schemas';
export type ParsedArtifact =
  | { kind: 'constraint_set'; value: ConstraintSetArtifact }
  | { kind: 'patch'; value: PatchArtifact };
export function parseModelText(text: string): ParsedArtifact | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const type = (obj as { type?: string }).type;
  if (type === 'constraint_set') {
    const r = ConstraintSetArtifactSchema.safeParse(obj);
    return r.success ? { kind: 'constraint_set', value: r.data } : null;
  }
  if (type === 'patch') {
    const r = PatchArtifactSchema.safeParse(obj);
    return r.success ? { kind: 'patch', value: r.data } : null;
  }
  return null;
}
```

- [ ] **Step 4: 写失败测试 `functions/__tests__/artifacts.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { parseModelText } from '../artifacts';
import { buildSystemPrompt, buildUserMessage } from '../prompt';
const validSet = { type: 'constraint_set', plan_title: '考研冲刺', horizon_days: 7, task_defs: [{ key: 'math', title: '数学真题', category: 'study', duration_min: 90, frequency: { type: 'daily' } }], constraints: [], clarifications_needed: [] };
describe('artifacts', () => {
  it('解析裸 JSON constraint_set', () => {
    const r = parseModelText(JSON.stringify(validSet));
    expect(r?.kind).toBe('constraint_set');
  });
  it('解析 ```json 围栏', () => {
    const r = parseModelText('前言\n```json\n' + JSON.stringify(validSet) + '\n```\n后语');
    expect(r?.kind).toBe('constraint_set');
  });
  it('解析 patch', () => {
    const r = parseModelText(JSON.stringify({ type: 'patch', summary: '移动数学', ops: [{ op: 'move_block', id: 'b1', start_utc: '2026-11-17T01:00:00Z', end_utc: '2026-11-17T02:30:00Z' }] }));
    expect(r?.kind).toBe('patch');
  });
  it('普通文本 → null', () => { expect(parseModelText('你好，请告诉我你的目标')).toBeNull(); });
  it('非法 JSON → null', () => { expect(parseModelText('{bad')).toBeNull(); });
  it('schema 不合法 → null', () => { expect(parseModelText(JSON.stringify({ type: 'constraint_set', task_defs: [] }))).toBeNull(); });
  it('prompt 含关键约束词', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('constraint_set');
    expect(p).toContain('clarifications_needed');
  });
  it('buildUserMessage 无计划时提示生成', () => {
    expect(buildUserMessage({ message: '排个计划', plan: null, history: [] })).toContain('constraint_set');
  });
});
```

- [ ] **Step 5: 运行测试 + deno check**

Run: `npx vitest run functions/__tests__/artifacts.test.ts && npx deno check functions/app.ts`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add functions/prompt.ts functions/artifacts.ts functions/engine.ts functions/__tests__/artifacts.test.ts
git commit -m "feat(m2): system prompt, model artifact parsing, engine re-export"
```

---

### Task 4: 持久化 QCA 协调器（cloud_bindings）与派发幂等（dispatch_intents）

**Files:**
- Create: `functions/qca/coordinator.ts`、`functions/qca/dispatch.ts`
- Test: `functions/__tests__/coordinator.test.ts`

**Interfaces:**
- Consumes: `Db`/`rows`、`fail`、`createMemoryDb`（测试）
- Produces: `createDbCoordinator(db):Coordinator`，`Coordinator.withLock<T>(key,fn:(lease:Lease)=>Promise<T>):Promise<T>`，`Lease{read():Promise<BindingRecord|null>;write(rec:{state:string;id?:string|null;version?:number;fingerprint?:string|null}):Promise<void>;assertHeld():Promise<void>}`，`BindingRecord{state:string;id:string|null;version:number;fingerprint:string|null}`；`beginDispatch(db,input):Promise<{replay:boolean;intent:DispatchIntent}>`；`markDispatch(db,requestId,patch):Promise<void>`

> 与 vendored `ensureCloudResources` 对齐：`lease.read()` 在仅存在锁占位行（state=null）时返回 null；`lease.write({state:'ready',id,version})` 由 helper 调用。占位行不得被 read 视为已存在绑定，否则首次创建会被误判 pending。残留限制（initialization.md）：DB 提供租约 CAS 与唯一键幂等，但「读租约→创建云资源→写绑定」跨实例非严格原子；M2 单访客低并发下可接受，云资源创建由 `ensureCloudResources` 的 applicationScope+指纹幂等兜底。

- [ ] **Step 1: 写 `functions/qca/coordinator.ts`**

```ts
import { rows } from '../db';
import type { Db } from '../db';
import { fail } from '../errors';
export interface BindingRecord { state: string; id: string | null; version: number; fingerprint: string | null }
export interface Lease { read(): Promise<BindingRecord | null>; write(rec: { state: string; id?: string | null; version?: number; fingerprint?: string | null }): Promise<void>; assertHeld(): Promise<void> }
export interface Coordinator { withLock<T>(key: string, fn: (lease: Lease) => Promise<T>): Promise<T> }
const LEASE_TTL_MS = 30_000;
export function createDbCoordinator(db: Db): Coordinator {
  return {
    async withLock(key, fn) {
      const token = crypto.randomUUID();
      const nowIso = () => new Date().toISOString();
      rows(await db.from('cloud_bindings').insertIfAbsent(
        { key, state: null, resource_id: null, version: 0, fingerprint: null, lease_token: null, updated_at: nowIso() },
        { onConflict: 'key' },
      ));
      let acquired = false;
      for (let attempt = 0; attempt < 5 && !acquired; attempt++) {
        const row = rows(await db.from('cloud_bindings').select('lease_token,updated_at').eq('key', key).limit(1))[0];
        const held = row?.lease_token != null && Date.now() - Date.parse(row.updated_at) < LEASE_TTL_MS;
        if (held) { await new Promise((r) => setTimeout(r, 50)); continue; }
        const got = rows(await db.from('cloud_bindings').update({ lease_token: token, updated_at: nowIso() })
          .eq('key', key).eq('lease_token', row?.lease_token ?? null).select('key'));
        acquired = got.length > 0;
      }
      if (!acquired) fail('service_unavailable', 503);
      const lease: Lease = {
        async read() {
          const r = rows(await db.from('cloud_bindings').select('state,resource_id,version,fingerprint').eq('key', key).limit(1))[0];
          if (!r || r.state == null) return null;
          return { state: r.state, id: r.resource_id, version: r.version, fingerprint: r.fingerprint };
        },
        async write(rec) {
          rows(await db.from('cloud_bindings').update({ state: rec.state, resource_id: rec.id ?? null, version: rec.version ?? 0, fingerprint: rec.fingerprint ?? null, updated_at: nowIso() })
            .eq('key', key).eq('lease_token', token).select('key'));
        },
        async assertHeld() {
          const r = rows(await db.from('cloud_bindings').select('lease_token').eq('key', key).limit(1))[0];
          if (r?.lease_token !== token) fail('service_unavailable', 503);
        },
      };
      try { return await fn(lease); }
      finally {
        await db.from('cloud_bindings').update({ lease_token: null, updated_at: nowIso() }).eq('key', key).eq('lease_token', token);
      }
    },
  };
}
```

- [ ] **Step 2: 写 `functions/qca/dispatch.ts`**

```ts
import { rows } from '../db';
import type { Db } from '../db';
import { fail } from '../errors';
export interface DispatchIntent { request_id: string; visitor_id: string; conversation_id: string; status: string; payload_fingerprint: string; session_id: string | null; result: unknown }
export async function beginDispatch(db: Db, input: { request_id: string; visitor_id: string; conversation_id: string; payload_fingerprint: string }): Promise<{ replay: boolean; intent: DispatchIntent }> {
  rows(await db.from('dispatch_intents').insertIfAbsent(
    { ...input, status: 'pending', session_id: null, result: null },
    { onConflict: 'request_id' },
  ));
  const intent = rows(await db.from('dispatch_intents').select('*').eq('request_id', input.request_id).limit(1))[0] as DispatchIntent;
  if (intent.payload_fingerprint !== input.payload_fingerprint) fail('conflict', 409);
  return { replay: intent.status === 'done', intent };
}
export async function markDispatch(db: Db, requestId: string, patch: Partial<DispatchIntent>): Promise<void> {
  rows(await db.from('dispatch_intents').update(patch).eq('request_id', requestId).select('request_id'));
}
```
> 偏差 #5：契约 `dispatch_intents` 仅含 request_id/conversation_id/visitor_id/status/created_at/resolved_at。M2 迁移为其增列 `payload_fingerprint text`、`session_id text`、`result jsonb`（回放与对账所需），`status` 取值扩展为 pending/done/failed/interrupted（去掉 CHECK）。`conflict` 为同键不同指纹的幂等冲突，映射 HTTP 409（复用 version_conflict 语义位，错误码表保留）。

- [ ] **Step 3: 写失败测试 `functions/__tests__/coordinator.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../dev/fake-db';
import { createDbCoordinator } from '../qca/coordinator';
import { beginDispatch, markDispatch } from '../qca/dispatch';
describe('coordinator', () => {
  it('withLock 内 write 持久化，read 取回', async () => {
    const db = createMemoryDb();
    const coord = createDbCoordinator(db);
    await coord.withLock('scope-a', async (lease) => {
      expect(await lease.read()).toBeNull();
      await lease.write({ state: 'ready', id: 'agent_1', version: 1, fingerprint: 'fp' });
    });
    const again = await coord.withLock('scope-a', async (lease) => lease.read());
    expect(again).toEqual({ state: 'ready', id: 'agent_1', version: 1, fingerprint: 'fp' });
  });
  it('释放后租约清空（可再次获取）', async () => {
    const db = createMemoryDb();
    const coord = createDbCoordinator(db);
    await coord.withLock('k', async () => {});
    const row = db.tables.cloud_bindings.find((r) => r.key === 'k');
    expect(row.lease_token).toBeNull();
  });
  it('assertHeld 在租约被夺后抛错', async () => {
    const db = createMemoryDb();
    const coord = createDbCoordinator(db);
    await coord.withLock('k', async (lease) => {
      await db.from('cloud_bindings').update({ lease_token: 'other' }).eq('key', 'k');
      await expect(lease.assertHeld()).rejects.toMatchObject({ code: 'service_unavailable' });
    });
  });
});
describe('dispatch idempotency', () => {
  const input = { request_id: 'req-1', visitor_id: 'v', conversation_id: 'c', payload_fingerprint: 'fp1' };
  it('首次 pending，非 replay', async () => {
    const db = createMemoryDb();
    const r = await beginDispatch(db, input);
    expect(r.replay).toBe(false);
    expect(r.intent.status).toBe('pending');
  });
  it('完成后同 key 同指纹 → replay', async () => {
    const db = createMemoryDb();
    await beginDispatch(db, input);
    await markDispatch(db, 'req-1', { status: 'done', result: { ok: true } });
    const r = await beginDispatch(db, input);
    expect(r.replay).toBe(true);
    expect(r.intent.result).toEqual({ ok: true });
  });
  it('同 key 不同指纹 → 409 conflict', async () => {
    const db = createMemoryDb();
    await beginDispatch(db, input);
    await expect(beginDispatch(db, { ...input, payload_fingerprint: 'fp2' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });
});
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run functions/__tests__/coordinator.test.ts`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add functions/qca/coordinator.ts functions/qca/dispatch.ts functions/__tests__/coordinator.test.ts
git commit -m "feat(m2): durable cloud-binding coordinator and dispatch idempotency"
```

---

### Task 5: 上游帧投影（project.ts）

**Files:**
- Create: `functions/qca/project.ts`
- Test: `functions/__tests__/project.test.ts`

**Interfaces:**
- Consumes: `AppEvent`（Task 1）
- Produces: `createProjector(seq:()=>number, deltaSeq:number)` → `{push(ev:any):AppEvent[]; text():string; isTerminal():boolean}`。输入为 `JSON.parse(frame.data)` 后的上游 event 对象（`ev.type` ∈ `event_start`/`event_delta`/`agent.message`/`session.*`）。所有 `delta` 事件复用固定 `deltaSeq`（同一条流式 assistant 消息），其余事件用 `seq()` 递增。

> 上游精确帧形态（streaming.md）：`event_delta` 携带 `event_id` 与 `delta:{type:'content_delta',index,content:{type:'text',text}}`；缓冲 `agent.message` 为完整规范消息（同 event id，`content` 数组）；session 状态/错误事件决定 running/idle/failed。EOF≠完成。session 状态事件的精确 `type` 字符串需在 Task 16 联调时以真实帧确认；投影器以 `type` 前缀 `session` + `status/state` 字段容错判定终态。

- [ ] **Step 1: 写 `functions/qca/project.ts`**

```ts
import type { AppEvent } from '../types';
export function createProjector(seq: () => number, deltaSeq: number) {
  const drafts = new Map<string, string>();
  let streamed = false;
  let terminal = false;
  let failed = false;
  const fullText = () => [...drafts.values()].join('');
  return {
    push(ev: any): AppEvent[] {
      const out: AppEvent[] = [];
      const type: string = ev?.type ?? '';
      if (type === 'event_delta' && ev.delta?.type === 'content_delta') {
        const t: string = ev.delta.content?.text ?? '';
        const id: string = ev.event_id ?? '0';
        if (t) {
          drafts.set(id, (drafts.get(id) ?? '') + t);
          streamed = true;
          out.push({ event: 'delta', data: { seq: deltaSeq, text: t } });
        }
      } else if (type === 'agent.message') {
        const t: string = (ev.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
        const id: string = ev.id ?? ev.event_id ?? '0';
        drafts.set(id, t);
        if (!streamed && t) out.push({ event: 'delta', data: { seq: deltaSeq, text: t } });
      } else if (type.startsWith('session')) {
        const state: string = ev.status ?? ev.state ?? '';
        if (type === 'session.error' || state === 'failed' || state === 'error') {
          terminal = true; failed = true;
          out.push({ event: 'error', data: { seq: seq(), code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() } });
        } else if (state === 'idle' || state === 'completed' || type === 'session.completed') {
          terminal = true;
          out.push({ event: 'status', data: { seq: seq(), state: failed ? 'failed' : 'completed' } });
        }
      }
      return out;
    },
    text: fullText,
    isTerminal: () => terminal,
  };
}
```

- [ ] **Step 2: 写失败测试 `functions/__tests__/project.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createProjector } from '../qca/project';
const seqFactory = () => { let n = 100; return () => ++n; };
const DELTA_SEQ = 7;
describe('projector', () => {
  it('content_delta 增量投影为 delta 事件（固定 deltaSeq）并累积文本', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const a = p.push({ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: '你' } } });
    const b = p.push({ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: '好' } } });
    expect(a[0]).toMatchObject({ event: 'delta', data: { seq: DELTA_SEQ, text: '你' } });
    expect(b[0].data).toMatchObject({ seq: DELTA_SEQ, text: '好' });
    expect(p.text()).toBe('你好');
  });
  it('已流式输出后，缓冲 agent.message 不再重复发 delta', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    p.push({ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '你好' } } });
    const out = p.push({ type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '你好' }] });
    expect(out).toHaveLength(0);
    expect(p.text()).toBe('你好');
  });
  it('无流式 delta 时，缓冲消息发一条完整 delta', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '完整回复' }] });
    expect(out[0]).toMatchObject({ event: 'delta', data: { seq: DELTA_SEQ, text: '完整回复' } });
  });
  it('session idle → completed 终态（递增 seq）', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'session.status', status: 'idle' });
    expect(out[0]).toMatchObject({ event: 'status', data: { state: 'completed' } });
    expect(out[0].data.seq).toBeGreaterThan(DELTA_SEQ);
    expect(p.isTerminal()).toBe(true);
  });
  it('session error → failed 终态，不被后续 idle 翻转为成功', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    p.push({ type: 'session.error' });
    const out = p.push({ type: 'session.status', status: 'idle' });
    expect(out[0]).toMatchObject({ event: 'status', data: { state: 'failed' } });
  });
  it('event_start 不产生事件', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    expect(p.push({ type: 'event_start', id: 'e1' })).toHaveLength(0);
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run functions/__tests__/project.test.ts`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add functions/qca/project.ts functions/__tests__/project.test.ts
git commit -m "feat(m2): upstream frame to AppEvent projector"
```

---

### Task 6: 会话/Session 懒映射（sessions.ts）与 GET /conversations

**Files:**
- Create: `functions/qca/sessions.ts`、`functions/routes/conversations.ts`
- Modify: `functions/app.ts`（注册 /api/conversations）
- Test: `functions/__tests__/sessions.test.ts`

**Interfaces:**
- Consumes: `Db`/`rows`/`fail`/`Deps`/`RouteCtx`/`requireVisitor`/`createMemoryDb`/`createFakeQca`
- Produces: `Conversation{id;owner_visitor_id;title;qca_session_id:string|null;last_seq:number;last_event_id:string|null;status:string;plan_id:string|null}`；`listConversations(db,visitor)`；`getOwnedConversation(db,visitor,id)`（不存在 404、跨访客 403）；`ensureConversation(db,visitor,id?,title?,planId?)`；`ensureQcaSession(deps,conv):Promise<{sessionId:string}>`（回填 qca_session_id）；`conversations` handler

> 偏差 #6：契约 `conversations` 无 `last_event_id`/`title` 列。M2 迁移增列 `last_event_id text`（SSE 游标续流所需）与 `title text`（会话列表展示）。归属列为 `owner_visitor_id`（契约一致）。

- [ ] **Step 1: 写 `functions/qca/sessions.ts`**

```ts
import { rows } from '../db';
import type { Db } from '../db';
import { fail } from '../errors';
import type { Deps } from '../types';
export interface Conversation { id: string; owner_visitor_id: string; title: string; qca_session_id: string | null; last_seq: number; last_event_id: string | null; status: string; plan_id: string | null }
export async function listConversations(db: Db, visitor: string): Promise<Conversation[]> {
  return rows(await db.from('conversations').select('*').eq('owner_visitor_id', visitor).order('updated_at', { ascending: false }).limit(50));
}
export async function getOwnedConversation(db: Db, visitor: string, id: string): Promise<Conversation> {
  const c = rows(await db.from('conversations').select('*').eq('id', id).limit(1))[0];
  if (!c) fail('not_found', 404);
  if (c.owner_visitor_id !== visitor) fail('forbidden', 403);
  return c;
}
export async function ensureConversation(db: Db, visitor: string, id?: string | null, title?: string, planId?: string | null): Promise<Conversation> {
  if (id) return getOwnedConversation(db, visitor, id);
  return rows(await db.from('conversations').insert({ owner_visitor_id: visitor, title: title ?? '新对话', plan_id: planId ?? null, qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' }).select('*'))[0];
}
export async function ensureQcaSession(deps: Deps, conv: Conversation): Promise<{ sessionId: string }> {
  if (conv.qca_session_id) return { sessionId: conv.qca_session_id };
  const binding = await deps.qca.ensureBinding(deps.config.appScope);
  const session = await deps.qca.createSession(binding, conv.title, { visitor_id: conv.owner_visitor_id, conversation_id: conv.id });
  rows(await deps.db.from('conversations').update({ qca_session_id: session.id }).eq('id', conv.id).eq('owner_visitor_id', conv.owner_visitor_id).select('id'));
  return { sessionId: session.id };
}
```

- [ ] **Step 2: 写 `functions/routes/conversations.ts`**

```ts
import { requireVisitor } from '../identity';
import { listConversations } from '../qca/sessions';
import type { Deps, RouteCtx } from '../types';
export async function conversations(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const items = await listConversations(deps.db, visitor);
  return Response.json({ items }, { headers: { 'cache-control': 'no-store' } });
}
```

- [ ] **Step 3: 注册到 `functions/app.ts`**

```ts
import { conversations } from './routes/conversations';
// routes 数组追加：
{ method: 'GET', pattern: /^\/api\/conversations$/, handler: conversations },
```

- [ ] **Step 4: 写失败测试 `functions/__tests__/sessions.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { ensureConversation, getOwnedConversation, ensureQcaSession, listConversations } from '../qca/sessions';
import type { Deps } from '../types';
const deps = (db = createMemoryDb()): Deps => ({ db, requireUser: () => ({ id: 'v' }), qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 'scope', modelId: 'm' } });
describe('sessions', () => {
  it('ensureConversation 无 id 创建归属会话', async () => {
    const db = createMemoryDb();
    const c = await ensureConversation(db, 'v', null, '考研');
    expect(c.owner_visitor_id).toBe('v');
    expect(c.qca_session_id).toBeNull();
  });
  it('跨访客读取 → 403', async () => {
    const db = createMemoryDb();
    const c = await ensureConversation(db, 'v', null);
    await expect(getOwnedConversation(db, 'other', c.id)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });
  it('不存在 → 404', async () => {
    await expect(getOwnedConversation(createMemoryDb(), 'v', 'nope')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
  it('ensureQcaSession 懒创建并回填，二次复用不重复创建', async () => {
    const d = deps();
    const c = await ensureConversation(d.db, 'v', null);
    const first = await ensureQcaSession(d, c);
    const updated = await getOwnedConversation(d.db, 'v', c.id);
    const second = await ensureQcaSession(d, updated);
    expect(second.sessionId).toBe(first.sessionId);
    expect(d.db.tables.conversations[0].qca_session_id).toBe(first.sessionId);
  });
  it('listConversations 仅返回本访客', async () => {
    const db = createMemoryDb();
    await ensureConversation(db, 'v', null);
    await ensureConversation(db, 'other', null);
    expect(await listConversations(db, 'v')).toHaveLength(1);
  });
});
```

- [ ] **Step 5: 运行测试 + deno check**

Run: `npx vitest run functions/__tests__/sessions.test.ts && npx deno check functions/app.ts`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add functions/qca/sessions.ts functions/routes/conversations.ts functions/app.ts functions/__tests__/sessions.test.ts
git commit -m "feat(m2): conversation ownership, lazy QCA session mapping, /conversations"
```

---

### Task 7: 对话 SSE 路由（send / history / events / interrupt）

**Files:**
- Create: `functions/routes/chat.ts`、`functions/sse-app.ts`（下游带 id 的 SSE 编码 + messages 持久化助手）
- Modify: `functions/app.ts`（注册 4 条 chat 路由）、`dev/fake-qca.ts`（支持脚本化上游帧）
- Test: `functions/__tests__/chat.test.ts`

**Interfaces:**
- Consumes: `readJson`（Task 1）、`requireVisitor`、`incrementChatTurn`/`assertNoPendingDispatch`/`todayStr`、`beginDispatch`/`markDispatch`、`ensureConversation`/`getOwnedConversation`/`ensureQcaSession`、`createProjector`、`parseModelText`、`buildSystemPrompt`/`buildUserMessage`、`readSSE`（vendored `functions/qca/sse.mjs`）、`LIMITS`
- Produces: `chatSend`/`chatHistory`/`chatEvents`/`chatInterrupt` handlers；`appFrame(seq,event,data):Uint8Array`；`persistMessage(db,conv,role,content,seq,eventId?)`；`advanceCursor(db,conv,seq,eventId?)`；`interruptRegistry:Map<string,AbortController>`（单实例内存，M2 限制）

> 顺序硬约束（spec §3/§5）：归属/大小 → 配额（超限 429 上游零调用）→ 并发（pending 409）→ dispatch_intents 占位 → 懒 Session → **先连流再派发** → 投影持久化 → done/failed 回填。重复 request_id 回放不重发。未知结果保持 pending。EOF≠完成。interrupt 跨请求中止依赖单实例内存 registry（M2 单实例可接受，多实例需 DB 信号，后置）。

- [ ] **Step 1: 扩展 `dev/fake-qca.ts` 支持脚本化帧**

在 `createFakeQca` 的默认 `openStream` 之外，允许 overrides 注入。追加导出助手：
```ts
import { encodeSSE } from '../functions/qca/sse.mjs';
export function upstreamStream(events: any[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const ev of events) controller.enqueue(encodeSSE(ev.type ?? 'message', ev));
      controller.close();
    },
  });
}
```
默认 `openStream` 返回 `upstreamStream([])`；`sendEvents` 默认返回 `{ eventIds: ['evt_fake'] }`。测试用 `createFakeQca({ openStream: async () => ({ body: upstreamStream([...]), close() {} }) })`。

- [ ] **Step 2: 写 `functions/sse-app.ts`**

```ts
import { rows } from './db';
import type { Db } from './db';
import type { Conversation } from './qca/sessions';
export function appFrame(seq: number, event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
export async function insertMessage(db: Db, conv: Conversation, msg: { seq: number; role: string; kind: string; content?: string; payload?: unknown }): Promise<void> {
  rows(await db.from('messages').insert({ conversation_id: conv.id, seq: msg.seq, role: msg.role, kind: msg.kind, content: msg.content ?? '', payload: msg.payload ?? null }).select('id'));
}
export async function appendAssistant(db: Db, conv: Conversation, seq: number, text: string): Promise<void> {
  const existing = rows(await db.from('messages').select('id,content').eq('conversation_id', conv.id).eq('seq', seq).limit(1))[0];
  if (existing) rows(await db.from('messages').update({ content: existing.content + text }).eq('id', existing.id).select('id'));
  else rows(await db.from('messages').insert({ conversation_id: conv.id, seq, role: 'assistant', kind: 'text', content: text, payload: null }).select('id'));
}
export async function advanceCursor(db: Db, conv: Conversation, seq: number, eventId?: string | null): Promise<void> {
  rows(await db.from('conversations').update({ last_seq: seq, last_event_id: eventId ?? conv.last_event_id, updated_at: new Date().toISOString() })
    .eq('id', conv.id).eq('owner_visitor_id', conv.owner_visitor_id).select('id'));
}
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 3: 写 `functions/routes/chat.ts`**

```ts
import { readJson } from '../router';
import { fail } from '../errors';
import { rows } from '../db';
import { requireVisitor } from '../identity';
import { incrementChatTurn, assertNoPendingDispatch, todayStr } from '../quotas';
import { beginDispatch, markDispatch } from '../qca/dispatch';
import { ensureConversation, getOwnedConversation, ensureQcaSession } from '../qca/sessions';
import { createProjector } from '../qca/project';
import { parseModelText } from '../artifacts';
import { buildUserMessage } from '../prompt';
import { appFrame, insertMessage, appendAssistant, advanceCursor, sha256Hex } from '../sse-app';
import { readSSE } from '../qca/sse.mjs';
import { LIMITS } from '../../shared/constants';
import type { Deps, RouteCtx, AppEvent } from '../types';

export const interruptRegistry = new Map<string, AbortController>();
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' };

async function loadPlanState(db: Deps['db'], visitor: string, planId: string | null) {
  if (!planId) return null;
  const plan = rows(await db.from('plans').select('*').eq('id', planId).eq('owner_visitor_id', visitor).limit(1))[0];
  if (!plan) return null;
  const task_defs = rows(await db.from('task_defs').select('*').eq('plan_id', planId));
  const constraints = rows(await db.from('constraints').select('*').eq('plan_id', planId));
  const blocks = rows(await db.from('blocks').select('*').eq('plan_id', planId));
  return { plan, task_defs, constraints, blocks };
}

export async function chatSend(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 8192);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > LIMITS.messageChars) fail('validation_failed', 422);
  const requestId = typeof body.request_id === 'string' && body.request_id ? body.request_id : crypto.randomUUID();
  const conv = await ensureConversation(deps.db, visitor, body.conversation_id ?? null, text.slice(0, 30), body.plan_id ?? null);
  const day = todayStr(deps.now?.() ?? new Date());
  await incrementChatTurn(deps.db, visitor, day);
  await assertNoPendingDispatch(deps.db, visitor);
  const fingerprint = await sha256Hex(`${conv.id}:${text}`);
  const { replay, intent } = await beginDispatch(deps.db, { request_id: requestId, visitor_id: visitor, conversation_id: conv.id, payload_fingerprint: fingerprint });
  const planState = await loadPlanState(deps.db, visitor, body.plan_id ?? null);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = conv.last_seq;
      const nextSeq = () => ++seq;
      const emit = (e: AppEvent) => controller.enqueue(appFrame(e.data.seq, e.event, e.data));
      const abort = new AbortController();
      interruptRegistry.set(conv.id, abort);
      try {
        const userSeq = nextSeq();
        emit({ event: 'accepted', data: { request_id: requestId, conversation_id: conv.id, seq: userSeq } });
        await insertMessage(deps.db, conv, { seq: userSeq, role: 'user', kind: 'text', content: text });
        await advanceCursor(deps.db, conv, seq);
        if (replay) {
          for (const e of (intent.result ?? []) as AppEvent[]) emit({ ...e, data: { ...e.data, seq: nextSeq() } } as AppEvent);
          emit({ event: 'done', data: { seq: nextSeq() } });
          return;
        }
        const { sessionId } = await ensureQcaSession(deps, conv);
        const collected: AppEvent[] = [];
        const assistantSeq = nextSeq();
        let finalText = '';
        let terminalState: 'completed' | 'failed' | 'interrupted' = 'failed';
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await deps.db.from('messages').delete().eq('conversation_id', conv.id).eq('seq', assistantSeq);
          const projector = createProjector(nextSeq, assistantSeq);
          const upstream = await deps.qca.openStream(sessionId, { lastEventId: conv.last_event_id ?? undefined, signal: abort.signal });
          let lastEventId: string | null = conv.last_event_id;
          try {
            await deps.qca.sendEvents(sessionId, buildUserMessage({ message: text, plan: planState, history: [] }), `${requestId}:${attempt}`);
            for await (const frame of readSSE(upstream.body, { signal: abort.signal })) {
              const ev = JSON.parse(frame.data);
              if (frame.id) lastEventId = frame.id;
              for (const p of projector.push(ev)) {
                emit(p); collected.push(p);
                if (p.event === 'delta') await appendAssistant(deps.db, conv, p.data.seq, p.data.text);
                if (p.event === 'status') { terminalState = p.data.state === 'completed' ? 'completed' : 'failed'; await insertMessage(deps.db, conv, { seq: p.data.seq, role: 'system', kind: 'status', content: p.data.state }); }
                if (p.event === 'error') { terminalState = 'failed'; await insertMessage(deps.db, conv, { seq: p.data.seq, role: 'system', kind: 'error', content: p.data.code }); }
              }
            }
          } finally { upstream.close(); }
          finalText = projector.text();
          if (abort.signal.aborted) { terminalState = 'interrupted'; break; }
          if (!projector.isTerminal()) { terminalState = 'failed'; break; }
          const expectsArtifact = /```json|^\s*\{/.test(finalText);
          const parsed = parseModelText(finalText);
          if (parsed) {
            const art: AppEvent = { event: 'artifact', data: { seq: nextSeq(), kind: parsed.kind, payload: parsed.value } };
            emit(art); collected.push(art);
            await insertMessage(deps.db, conv, { seq: art.data.seq, role: 'assistant', kind: parsed.kind, content: finalText, payload: parsed.value });
            break;
          }
          if (expectsArtifact && attempt < 2) continue;
          if (expectsArtifact) {
            const err: AppEvent = { event: 'error', data: { seq: nextSeq(), code: 'artifact_invalid', message: 'AI 返回的结构化结果无效，请重试', diagnostic_id: crypto.randomUUID() } };
            emit(err); collected.push(err); terminalState = 'failed';
            await insertMessage(deps.db, conv, { seq: err.data.seq, role: 'system', kind: 'error', content: 'artifact_invalid' });
          }
          break;
        }
        await advanceCursor(deps.db, conv, seq, conv.last_event_id);
        const status: AppEvent = { event: 'status', data: { seq: nextSeq(), state: terminalState } };
        emit(status); collected.push(status);
        emit({ event: 'done', data: { seq: nextSeq() } });
        await markDispatch(deps.db, requestId, { status: terminalState === 'completed' ? 'done' : terminalState, session_id: sessionId, result: collected });
        await deps.db.from('conversations').update({ status: terminalState === 'completed' ? 'active' : terminalState }).eq('id', conv.id);
      } catch {
        const err: AppEvent = { event: 'error', data: { seq: nextSeq(), code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() } };
        controller.enqueue(appFrame(err.data.seq, err.event, err.data));
        controller.enqueue(appFrame(nextSeq(), 'done', { seq }));
        await markDispatch(deps.db, requestId, { status: 'failed' }).catch(() => {});
      } finally {
        interruptRegistry.delete(conv.id);
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 202, headers: SSE_HEADERS });
}

export async function chatHistory(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const id = new URL(ctx.request.url).searchParams.get('conversation_id') ?? '';
  const conv = await getOwnedConversation(deps.db, visitor, id);
  const messages = rows(await deps.db.from('messages').select('*').eq('conversation_id', id).order('seq', { ascending: true }).limit(200));
  return Response.json({ conversation: conv, messages }, { headers: { 'cache-control': 'no-store' } });
}

export async function chatEvents(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const url = new URL(ctx.request.url);
  const id = url.searchParams.get('conversation_id') ?? '';
  const [cursorSeqStr, offsetStr] = (url.searchParams.get('cursor') ?? '0:0').split(':');
  const cursorSeq = Number(cursorSeqStr) || 0;
  const offset = Number(offsetStr) || 0;
  const conv = await getOwnedConversation(deps.db, visitor, id);
  const messages = rows(await deps.db.from('messages').select('*').eq('conversation_id', id).order('seq', { ascending: true }).limit(500));
  const pending = rows(await deps.db.from('dispatch_intents').select('request_id').eq('conversation_id', id).eq('status', 'pending').limit(1));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = conv.last_seq;
      const nextSeq = () => ++seq;
      try {
        for (const m of messages) {
          if (m.seq < cursorSeq) continue;
          if (m.kind === 'text' && m.role === 'assistant') {
            const t = m.seq === cursorSeq ? String(m.content).slice(offset) : String(m.content);
            controller.enqueue(appFrame(m.seq, 'delta', { seq: m.seq, text: t }));
          } else if (m.kind === 'constraint_set' || m.kind === 'patch') {
            controller.enqueue(appFrame(m.seq, 'artifact', { seq: m.seq, kind: m.kind, payload: m.payload }));
          } else if (m.kind === 'status') {
            controller.enqueue(appFrame(m.seq, 'status', { seq: m.seq, state: m.content }));
          } else if (m.kind === 'error') {
            controller.enqueue(appFrame(m.seq, 'error', { seq: m.seq, code: m.content, message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() }));
          }
        }
        if (pending.length) {
          const { sessionId } = await ensureQcaSession(deps, conv);
          const abort = new AbortController();
          interruptRegistry.set(conv.id, abort);
          const projector = createProjector(nextSeq, nextSeq());
          const upstream = await deps.qca.openStream(sessionId, { lastEventId: conv.last_event_id ?? undefined, signal: abort.signal });
          try {
            for await (const frame of readSSE(upstream.body, { signal: abort.signal })) {
              for (const p of projector.push(JSON.parse(frame.data))) controller.enqueue(appFrame(p.data.seq, p.event, p.data));
            }
          } finally { upstream.close(); interruptRegistry.delete(conv.id); }
        }
        controller.enqueue(appFrame(nextSeq(), 'done', { seq }));
      } catch {
        controller.enqueue(appFrame(nextSeq(), 'error', { seq, code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() }));
        controller.enqueue(appFrame(nextSeq(), 'done', { seq }));
      } finally { controller.close(); }
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

export async function chatInterrupt(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 2048);
  const conv = await getOwnedConversation(deps.db, visitor, String(body.conversation_id ?? ''));
  interruptRegistry.get(conv.id)?.abort();
  await deps.db.from('conversations').update({ status: 'interrupted' }).eq('id', conv.id).eq('owner_visitor_id', visitor);
  const pending = rows(await deps.db.from('dispatch_intents').select('request_id').eq('conversation_id', conv.id).eq('status', 'pending').limit(1));
  if (pending[0]) await markDispatch(deps.db, pending[0].request_id, { status: 'interrupted' });
  return Response.json({ ok: true, status: 'interrupted' });
}
```
`buildSystemPrompt()` 由真实 adapter（Task 9）在创建 QCA agent 时作为系统指令注入；`buildUserMessage` 已含计划上下文。`loadPlanState` 的 `plans.owner_visitor_id` 与迁移列一致（Task 10）。

- [ ] **Step 4: 注册 4 条路由到 `functions/app.ts`**

```ts
import { chatSend, chatHistory, chatEvents, chatInterrupt } from './routes/chat';
// routes 数组追加：
{ method: 'POST', pattern: /^\/api\/chat\/send$/, handler: chatSend },
{ method: 'GET', pattern: /^\/api\/chat\/history$/, handler: chatHistory },
{ method: 'GET', pattern: /^\/api\/chat\/events$/, handler: chatEvents },
{ method: 'POST', pattern: /^\/api\/chat\/interrupt$/, handler: chatInterrupt },
```

- [ ] **Step 5: 写失败测试 `functions/__tests__/chat.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca, upstreamStream } from '../../dev/fake-qca';
import { readSSE } from '../qca/sse.mjs';
import type { Deps, RouteCtx } from '../types';
function deps(qcaOverrides = {}, db = createMemoryDb()): Deps {
  return { db, requireUser: (ctx) => { if (!ctx.user) throw { code: 'unauthorized', status: 401 }; return ctx.user; }, qca: createFakeQca(qcaOverrides), config: { cloudApiOrigin: 'x', appScope: 'scope', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, user: { id: string } | null = { id: 'v' }): RouteCtx {
  return { request: new Request('http://x' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user };
}
async function collect(res: Response) {
  const out: any[] = [];
  for await (const f of readSSE(res.body!)) out.push({ event: f.event, data: JSON.parse(f.data) });
  return out;
}
const replyFrames = [
  { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '好的' } } },
  { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '好的' }] },
  { type: 'session.status', status: 'idle' },
];
describe('chatSend', () => {
  it('R6: 首事件 accepted，202，含 delta/status/done', async () => {
    const d = deps({ openStream: async () => ({ body: upstreamStream(replyFrames), close() {} }) });
    const res = await application(d)(ctx('POST', '/api/chat/send', { text: '帮我排个考研计划' }));
    expect(res.status).toBe(202);
    const frames = await collect(res);
    expect(frames[0].event).toBe('accepted');
    expect(frames.some((f) => f.event === 'delta')).toBe(true);
    expect(frames.at(-1).event).toBe('done');
  });
  it('R13: 配额耗尽 → 429，上游零调用', async () => {
    let calls = 0;
    const d = deps({ openStream: async () => { calls++; return { body: upstreamStream(replyFrames), close() {} }; } });
    const { incrementChatTurn } = await import('../quotas');
    for (let i = 0; i < 60; i++) await incrementChatTurn(d.db, 'v', '2026-11-16');
    const res = await application(d)(ctx('POST', '/api/chat/send', { text: 'hi' }));
    expect(res.status).toBe(429);
    expect(calls).toBe(0);
  });
  it('超长消息 → 422', async () => {
    const res = await application(deps())(ctx('POST', '/api/chat/send', { text: 'x'.repeat(2001) }));
    expect(res.status).toBe(422);
  });
  it('R7: 重复 request_id 回放，不重复派发', async () => {
    let sends = 0;
    const d = deps({ openStream: async () => ({ body: upstreamStream(replyFrames), close() {} }), sendEvents: async () => { sends++; return { eventIds: ['evt_1'] }; } });
    const app = application(d);
    const body = { text: '排计划', request_id: 'req-dup' };
    await collect(await app(ctx('POST', '/api/chat/send', body)));
    const second = await collect(await app(ctx('POST', '/api/chat/send', body)));
    expect(second[0].event).toBe('accepted');
    expect(sends).toBe(1);
  });
  it('artifact：合法 constraint_set 投影为 artifact 事件', async () => {
    const set = { type: 'constraint_set', plan_title: '考研', horizon_days: 7, task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' } }], constraints: [], clarifications_needed: [] };
    const frames = [{ type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '```json\n' + JSON.stringify(set) + '\n```' }] }, { type: 'session.status', status: 'idle' }];
    const d = deps({ openStream: async () => ({ body: upstreamStream(frames), close() {} }) });
    const out = await collect(await application(d)(ctx('POST', '/api/chat/send', { text: '排计划' })));
    expect(out.some((f) => f.event === 'artifact' && f.data.kind === 'constraint_set')).toBe(true);
  });
});
describe('chatHistory / interrupt', () => {
  it('history 跨访客 → 403', async () => {
    const d = deps();
    const { ensureConversation } = await import('../qca/sessions');
    const c = await ensureConversation(d.db, 'v', null);
    const res = await application(d)(ctx('GET', `/api/chat/history?conversation_id=${c.id}`, undefined, { id: 'other' }));
    expect(res.status).toBe(403);
  });
  it('interrupt 返回 interrupted', async () => {
    const d = deps();
    const { ensureConversation } = await import('../qca/sessions');
    const c = await ensureConversation(d.db, 'v', null);
    const res = await application(d)(ctx('POST', '/api/chat/interrupt', { conversation_id: c.id }));
    expect((await res.json()).status).toBe('interrupted');
  });
});
```

- [ ] **Step 6: 运行测试 + deno check**

Run: `npx vitest run functions/__tests__/chat.test.ts && npx deno check functions/app.ts`
Expected: 全绿（R6/R7/R13 + artifact + 403）。若 `readSSE` 在 vitest 下对 `res.body` 类型报错，用 `res.body!`。

- [ ] **Step 7: Commit**

```bash
git add functions/routes/chat.ts functions/sse-app.ts functions/app.ts dev/fake-qca.ts functions/__tests__/chat.test.ts
git commit -m "feat(m2): SSE chat send/history/events/interrupt with idempotent dispatch"
```

---

### Task 8: 计划路由与服务端权威 commit（plans.ts）

**Files:**
- Create: `functions/routes/plans.ts`
- Modify: `functions/app.ts`（注册 /api/plans、/api/plans/:id、/api/plans/commit）
- Test: `functions/__tests__/plans.test.ts`

**Interfaces:**
- Consumes: `readJson`/`requireVisitor`/`rows`/`fail`/`solve`/`resultHash`（`functions/engine`）/`ENGINE_VERSION`/`TaskDefSchema`/`ConstraintSchema`/`Deps`/`RouteCtx`
- Produces: `listPlans`/`getPlan`/`commitPlan` handlers；`getOwnedPlan(db,visitor,id)`；`fullPlan(deps,visitor,planId,server_authoritative)`

> commit 顺序（spec §3）：校验 → engine_version 比对（409）→ preview_id 回放（commit_log）→ 服务端 solve（violations 非空 → 422 engine_infeasible，DB 零写入）→ resultHash 比对（不一致 → server_authoritative:true）→ 写 plan/子表 → commit_log 占位。无通用事务：残留并发竞态由 preview_id 唯一键收敛（M2 单访客可接受）。`commit_log` 回放返回当前 plan 全量（不重算）。

- [ ] **Step 1: 写 `functions/routes/plans.ts`**

```ts
import { z } from 'zod';
import { readJson } from '../router';
import { fail } from '../errors';
import { rows } from '../db';
import type { Db } from '../db';
import { requireVisitor } from '../identity';
import { solve, resultHash } from '../engine';
import { ENGINE_VERSION, LIMITS } from '../../shared/constants';
import { TaskDefSchema, ConstraintSchema } from '../../shared/schemas';
import type { Deps, RouteCtx } from '../types';

const CommitSchema = z.object({
  preview_id: z.string().min(1),
  plan_id: z.string().min(1).nullable(),
  result_hash: z.string().min(1),
  engine_version: z.number(),
  input: z.object({
    title: z.string().min(1).max(LIMITS.titleChars),
    horizon_start: z.string().min(1),
    horizon_days: z.union([z.literal(7), z.literal(14)]),
    timezone: z.string().min(1),
    task_defs: z.array(TaskDefSchema).min(1).max(LIMITS.taskDefsMax),
    constraints: z.array(ConstraintSchema).max(LIMITS.constraintsMax),
  }),
});

export async function getOwnedPlan(db: Db, visitor: string, id: string) {
  const plan = rows(await db.from('plans').select('*').eq('id', id).limit(1))[0];
  if (!plan) fail('not_found', 404);
  if (plan.owner_visitor_id !== visitor) fail('forbidden', 403);
  return plan;
}
async function children(db: Db, planId: string) {
  return {
    task_defs: rows(await db.from('task_defs').select('*').eq('plan_id', planId)),
    constraints: rows(await db.from('constraints').select('*').eq('plan_id', planId)),
    blocks: rows(await db.from('blocks').select('*').eq('plan_id', planId).order('start_utc', { ascending: true })),
  };
}
export async function listPlans(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const items = rows(await deps.db.from('plans').select('id,title,status,horizon_start,horizon_days,timezone,version,updated_at').eq('owner_visitor_id', visitor).order('updated_at', { ascending: false }).limit(50));
  return Response.json({ items }, { headers: { 'cache-control': 'no-store' } });
}
export async function getPlan(ctx: RouteCtx, deps: Deps, params: string[]): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const plan = await getOwnedPlan(deps.db, visitor, params[0]);
  return Response.json({ plan, ...(await children(deps.db, plan.id)) }, { headers: { 'cache-control': 'no-store' } });
}
export async function commitPlan(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 262144);
  const parsed = CommitSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const { preview_id, plan_id, input, result_hash, engine_version } = parsed.data;
  if (engine_version !== ENGINE_VERSION) fail('engine_version_mismatch', 409);
  const existingLog = rows(await deps.db.from('commit_log').select('plan_id').eq('preview_id', preview_id).eq('visitor_id', visitor).limit(1))[0];
  if (existingLog) {
    const plan = await getOwnedPlan(deps.db, visitor, existingLog.plan_id);
    return Response.json({ plan, ...(await children(deps.db, plan.id)), version: plan.version, server_authoritative: false, violations: [], compromises: [] });
  }
  const output = solve({ engine_version: ENGINE_VERSION, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, task_defs: input.task_defs, constraints: input.constraints, pinned_blocks: [] });
  if (output.violations.length) fail('engine_infeasible', 422, { violations: output.violations, compromises: output.compromises });
  const serverHash = await resultHash(output.blocks);
  const server_authoritative = serverHash !== result_hash;
  let plan;
  if (plan_id) {
    const old = await getOwnedPlan(deps.db, visitor, plan_id);
    await deps.db.from('task_defs').delete().eq('plan_id', plan_id);
    await deps.db.from('constraints').delete().eq('plan_id', plan_id);
    await deps.db.from('blocks').delete().eq('plan_id', plan_id);
    plan = rows(await deps.db.from('plans').update({ title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, status: 'active', version: old.version + 1, updated_at: new Date().toISOString() }).eq('id', plan_id).eq('owner_visitor_id', visitor).select('*'))[0];
  } else {
    plan = rows(await deps.db.from('plans').insert({ owner_visitor_id: visitor, title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, status: 'active', version: 1 }).select('*'))[0];
  }
  for (const t of input.task_defs) {
    await deps.db.from('task_defs').insert({ plan_id: plan.id, key: t.key, title: t.title, category: t.category, duration_min: t.duration_min, frequency: t.frequency, priority: t.priority, splittable: t.splittable, preferred_period: t.preferred_period ?? null, sort_order: t.sort_order });
  }
  for (const c of input.constraints) {
    await deps.db.from('constraints').insert({ id: c.id, plan_id: plan.id, type: c.payload.type, payload: c.payload, source: c.source, enabled: c.enabled });
  }
  for (const b of output.blocks) {
    await deps.db.from('blocks').insert({ id: b.id, plan_id: plan.id, title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc, priority: b.priority, pinned: b.pinned, origin: b.origin, notes: b.notes ?? null });
  }
  await deps.db.from('commit_log').insertIfAbsent({ preview_id, visitor_id: visitor, plan_id: plan.id }, { onConflict: 'preview_id' });
  const blocks = rows(await deps.db.from('blocks').select('*').eq('plan_id', plan.id).order('start_utc', { ascending: true }));
  return Response.json({ plan, task_defs: input.task_defs, constraints: input.constraints, blocks, version: plan.version, server_authoritative, violations: [], compromises: output.compromises });
}
```

- [ ] **Step 2: 注册到 `functions/app.ts`**

```ts
import { listPlans, getPlan, commitPlan } from './routes/plans';
// routes 数组追加（注意 :id 路由放在 commit 之后以免吞掉 /plans/commit）：
{ method: 'POST', pattern: /^\/api\/plans\/commit$/, handler: commitPlan },
{ method: 'GET', pattern: /^\/api\/plans$/, handler: listPlans },
{ method: 'GET', pattern: /^\/api\/plans\/([^/]+)$/, handler: getPlan },
```

- [ ] **Step 3: 写失败测试 `functions/__tests__/plans.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { resultHash } from '../engine';
import { solve } from '../engine';
import type { Deps, RouteCtx } from '../types';
function deps(db = createMemoryDb()): Deps {
  return { db, requireUser: (ctx) => { if (!ctx.user) throw { code: 'unauthorized', status: 401 }; return ctx.user; }, qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, user: { id: string } | null = { id: 'v' }): RouteCtx {
  return { request: new Request('http://x' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user };
}
const taskDefs = [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }];
const baseInput = { title: '考研', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', task_defs: taskDefs, constraints: [] };
async function hashFor(input: any) {
  const out = solve({ engine_version: 1, ...input, pinned_blocks: [] });
  return resultHash(out.blocks);
}
describe('commitPlan', () => {
  it('R16: 新建 commit 落库 version=1，blocks 非空', async () => {
    const d = deps();
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'p1', plan_id: null, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(body.server_authoritative).toBe(false);
    expect(d.db.tables.plans).toHaveLength(1);
  });
  it('R17: result_hash 不匹配 → server_authoritative:true', async () => {
    const res = await application(deps())(ctx('POST', '/api/plans/commit', { preview_id: 'p2', plan_id: null, input: baseInput, result_hash: 'wrong', engine_version: 1 }));
    expect((await res.json()).server_authoritative).toBe(true);
  });
  it('R18: preview_id 回放不重复落库', async () => {
    const d = deps();
    const result_hash = await hashFor(baseInput);
    const body = { preview_id: 'p3', plan_id: null, input: baseInput, result_hash, engine_version: 1 };
    const app = application(d);
    await app(ctx('POST', '/api/plans/commit', body));
    const second = await app(ctx('POST', '/api/plans/commit', body));
    expect(second.status).toBe(200);
    expect(d.db.tables.plans).toHaveLength(1);
  });
  it('engine_version 不匹配 → 409', async () => {
    const res = await application(deps())(ctx('POST', '/api/plans/commit', { preview_id: 'p4', plan_id: null, input: baseInput, result_hash: 'x', engine_version: 99 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('engine_version_mismatch');
  });
  it('A3: 无解 → 422 engine_infeasible，DB 零写入', async () => {
    const d = deps();
    const input = { ...baseInput, constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '07:30' }, source: 'user', enabled: true }] };
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'p5', plan_id: null, input, result_hash: 'x', engine_version: 1 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('engine_infeasible');
    expect(d.db.tables.plans ?? []).toHaveLength(0);
  });
});
describe('getPlan', () => {
  it('跨访客 → 403', async () => {
    const d = deps();
    const result_hash = await hashFor(baseInput);
    const created = await (await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'p6', plan_id: null, input: baseInput, result_hash, engine_version: 1 }))).json();
    const res = await application(d)(ctx('GET', `/api/plans/${created.plan.id}`, undefined, { id: 'other' }));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 4: 运行测试 + deno check**

Run: `npx vitest run functions/__tests__/plans.test.ts && npx deno check functions/app.ts`
Expected: 全绿（R16/R17/R18/A3 + 409/403）。

- [ ] **Step 5: Commit**

```bash
git add functions/routes/plans.ts functions/app.ts functions/__tests__/plans.test.ts
git commit -m "feat(m2): plans list/get and server-authoritative idempotent commit"
```

---

### Task 9: 真实 QCA adapter、平台入口与本地 dev server

**Files:**
- Create: `functions/qca/live.ts`
- Modify: `functions/index.ts`（平台入口，替换 starter）、`dev/function-local.ts`（credential-free 本地 fixture）
- Delete: `functions/handler.ts`（starter hello，已被 app.ts 取代）
- Test: 无新增单测（live.ts 依赖 Deno-only 资产，部署实测；本地 `deno check functions/app.ts` 仍为类型 gate）

**Interfaces:**
- Consumes: `createCloudAgentsClient`/`ensureCloudResources`（vendored `functions/qca/cloud-agents.mjs`）、`createDbCoordinator`、`buildSystemPrompt`、`QcaAdapter`/`QcaBinding`/`Deps`、平台注入 `./_qoder/backend.mjs`（createDatabaseClient/createSiteContext/requireUser/errorResponse）
- Produces: `createLiveQca({db,config}):QcaAdapter`（懒 ensureBinding + 懒 model 解析 + session/send/stream/list）；`functions/index.ts` 平台入口；`dev/function-local.ts` 本地 fixture server

> 安全：`QODER_PAT` 仅由 vendored client 默认 `getToken=()=>Deno.env.get('QODER_PAT')` 读取；不下发浏览器、不入日志、不进 `prepare_site.secretNames`。`cloudApiOrigin` 取已验证 `https://api.qoder.com.cn`；`appScope` 为绑定 site 的稳定常量（非 Host/访客派生）。model 经 `GET /api/v1/cloud/models` 选首个 enabled，缓存。`index.ts` 导入平台注入 `_qoder/backend.mjs`，本地不可 deno check（偏差 #3），部署时验证。

- [ ] **Step 1: 写 `functions/qca/live.ts`**

```ts
import { createCloudAgentsClient, ensureCloudResources } from './cloud-agents.mjs';
import { createDbCoordinator } from './coordinator';
import { buildSystemPrompt } from '../prompt';
import { fail } from '../errors';
import type { Db } from '../db';
import type { QcaAdapter, QcaBinding } from '../types';
export function createLiveQca({ db, config }: { db: Db; config: { cloudApiOrigin: string; appScope: string; modelId: string } }): QcaAdapter {
  const client = createCloudAgentsClient({ origin: config.cloudApiOrigin });
  const coordinator = createDbCoordinator(db);
  let modelPromise: Promise<string> | null = null;
  let bindingPromise: Promise<QcaBinding> | null = null;
  const resolveModel = (): Promise<string> => {
    if (config.modelId) return Promise.resolve(config.modelId);
    modelPromise ??= client.request('/api/v1/cloud/models').then((r: any) => {
      const m = (r?.data ?? []).find((x: any) => x.enabled !== false);
      if (!m?.id) fail('service_unavailable', 503);
      return m.id as string;
    }).catch((e) => { modelPromise = null; throw e; });
    return modelPromise;
  };
  return {
    ensureBinding(scope) {
      bindingPromise ??= (async () => {
        const model = await resolveModel();
        return ensureCloudResources({
          client, coordinator, applicationScope: scope,
          agent: { name: 'Guidy 排程助手', model, system: buildSystemPrompt(), tools: [], metadata: { app: 'guidy', purpose: 'planning' } },
          environment: { name: 'Guidy 排程环境', config: { type: 'cloud' } },
        }) as Promise<QcaBinding>;
      })().catch((e) => { bindingPromise = null; throw e; });
      return bindingPromise;
    },
    async createSession(binding, title, metadata) {
      const r: any = await client.request('/api/v1/cloud/sessions', { method: 'POST', body: { ...binding, title, metadata } });
      if (!r?.id) fail('upstream_error', 502);
      return { id: r.id };
    },
    async sendEvents(sessionId, text, idempotencyKey) {
      const r: any = await client.request(`/api/v1/cloud/sessions/${sessionId}/events`, {
        method: 'POST', body: { events: [{ type: 'user.message', content: [{ type: 'text', text }] }] }, idempotencyKey,
      });
      return { eventIds: (r?.data ?? []).map((e: any) => e.id).filter(Boolean) };
    },
    openStream(sessionId, opts) { return client.openStream(sessionId, opts); },
    async listEvents(sessionId, opts) {
      const r: any = await client.request(`/api/v1/cloud/sessions/${sessionId}/events?order=${opts.order ?? 'asc'}&limit=${opts.limit ?? 100}`);
      return { data: r?.data ?? [], has_more: !!r?.has_more, next_page: r?.next_page };
    },
  };
}
```

- [ ] **Step 2: 替换 `functions/index.ts`（平台入口）**

```ts
import { createDatabaseClient, createSiteContext, requireUser, errorResponse } from './_qoder/backend.mjs';
import { application } from './app';
import { createLiveQca } from './qca/live';
const db = createDatabaseClient();
const config = {
  cloudApiOrigin: 'https://api.qoder.com.cn',
  appScope: 'guidy-site-01a1e421-fb71-7745-9db4-db763e874017',
  modelId: '',
};
const handle = application({ db, requireUser, qca: createLiveQca({ db, config }), config });
Deno.serve(async (request) => {
  let context;
  try { context = createSiteContext(request); return await handle(context); }
  catch (error) { return errorResponse(error, context?.requestId); }
});
```

- [ ] **Step 3: 替换 `dev/function-local.ts`（本地 fixture，明确标注非真实 AI）**

```ts
import { application } from '../functions/app';
import { createMemoryDb } from './fake-db';
import { createFakeQca, upstreamStream } from './fake-qca';
const db = createMemoryDb();
const cannedSet = { type: 'constraint_set', plan_title: '本地示例计划', horizon_days: 7, task_defs: [{ key: 'math', title: '数学真题', category: 'study', duration_min: 90, frequency: { type: 'daily' } }], constraints: [{ type: 'active_window', start: '07:00', end: '23:00' }], clarifications_needed: [] };
const cannedFrames = [
  { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '【本地 fixture】已生成示例约束：\n' } } },
  { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '【本地 fixture】已生成示例约束：\n```json\n' + JSON.stringify(cannedSet) + '\n```' }] },
  { type: 'session.status', status: 'idle' },
];
const qca = createFakeQca({ openStream: async () => ({ body: upstreamStream(cannedFrames), close() {} }) });
const handle = application({ db, requireUser: () => ({ id: 'local-visitor' }), qca, config: { cloudApiOrigin: 'http://local', appScope: 'local-dev', modelId: 'local-fixture' } });
console.log('Guidy local Function (FIXTURE, not real AI): http://127.0.0.1:8000');
Deno.serve({ hostname: '127.0.0.1', port: 8000 }, (request) => handle({ request, user: { id: 'local-visitor' }, requestId: crypto.randomUUID() }));
```

- [ ] **Step 4: 删除 starter `functions/handler.ts`**

Run: `git rm functions/handler.ts`

- [ ] **Step 5: 本地类型 gate + 启动 dev server 冒烟**

Run: `npx deno check functions/app.ts`
Expected: 无类型错误（app.ts 平台无关）。
Run（后台）: `npm run dev:function`，随后 `curl -s http://127.0.0.1:8000/api/health`
Expected: `{"ok":true,"engine_version":1}`。验证后停止该后台进程。

- [ ] **Step 6: Commit**

```bash
git add functions/qca/live.ts functions/index.ts dev/function-local.ts
git commit -m "feat(m2): live QCA adapter, platform entry, local fixture dev server"
```

---

### Task 10: 受限子集迁移 SQL（10 表）并经 Sites MCP 审阅应用

**Files:**
- Create: `functions/migrations/0001_m2.sql`（存档 reviewed SQL，非运行时依赖）
- 云资源：site `01a1e421-fb71-7745-9db4-db763e874017` / project `01a1e421-fb6e-756e-a7c8-44fd5a28b23f`

**Interfaces:**
- Consumes: Sites MCP `get_database_schema`/`create_database_migration`/`apply_database_migration`/`get_operation`
- Produces: `app` schema 下 10 张表（plans/task_defs/constraints/blocks/conversations/messages/dispatch_intents/commit_log/quotas/cloud_bindings）+ 新 `schemaRef`（供 Task 16 prepare_site）

> 偏差 #1（迁移受限子集）：`date`→`text`；删除所有 `CHECK`；partial index（WHERE）→普通索引；索引内 `DESC`→省略；省略 `CREATE SCHEMA`（app 已存在）；`text[]`/gin 索引属 M4 不建。FK `ON DELETE` 动作由工具校验，若被拒则去掉动作保留 plain `REFERENCES` 重新建计划。偏差 #2/#5/#6 的增列已并入下方 DDL。function_backend：`accessPolicies: []`。
> 授权：此为用户已批准的 M2 后端开通范围内的云写；**执行 apply 前向用户展示本 SQL 与计划并取得确认**。所有写用全新稳定 UUID `requestId`；未知结果保留原 requestId/refs 恢复，不新建意图。

- [ ] **Step 1: 写 `functions/migrations/0001_m2.sql`**

```sql
CREATE TABLE app.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_visitor_id text NOT NULL,
  title text NOT NULL,
  horizon_start text NOT NULL,
  horizon_days integer NOT NULL DEFAULT 7,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  status text NOT NULL DEFAULT 'draft',
  source_template_id uuid,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_owner_idx ON app.plans (owner_visitor_id, created_at);

CREATE TABLE app.task_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  key text NOT NULL,
  title text NOT NULL,
  category text NOT NULL,
  duration_min integer NOT NULL,
  frequency jsonb NOT NULL,
  priority text NOT NULL DEFAULT 'mid',
  splittable boolean NOT NULL DEFAULT false,
  preferred_period text,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (plan_id, key)
);

CREATE TABLE app.constraints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  source text NOT NULL DEFAULT 'user',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX constraints_plan_idx ON app.constraints (plan_id);

CREATE TABLE app.blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  task_def_id uuid REFERENCES app.task_defs(id) ON DELETE SET NULL,
  title text NOT NULL,
  category text NOT NULL,
  start_utc timestamptz NOT NULL,
  end_utc timestamptz NOT NULL,
  priority text NOT NULL DEFAULT 'mid',
  pinned boolean NOT NULL DEFAULT false,
  origin text NOT NULL DEFAULT 'engine',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blocks_plan_start_idx ON app.blocks (plan_id, start_utc);

CREATE TABLE app.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_visitor_id text NOT NULL,
  title text NOT NULL DEFAULT '新对话',
  plan_id uuid REFERENCES app.plans(id) ON DELETE SET NULL,
  qca_session_id text,
  status text NOT NULL DEFAULT 'active',
  last_seq bigint NOT NULL DEFAULT 0,
  last_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_owner_idx ON app.conversations (owner_visitor_id, updated_at);

CREATE TABLE app.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  role text NOT NULL,
  kind text NOT NULL,
  content text NOT NULL DEFAULT '',
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

CREATE TABLE app.dispatch_intents (
  request_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  payload_fingerprint text,
  session_id text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX dispatch_visitor_idx ON app.dispatch_intents (visitor_id, status);

CREATE TABLE app.commit_log (
  preview_id uuid PRIMARY KEY,
  visitor_id text NOT NULL,
  plan_id uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.quotas (
  visitor_id text NOT NULL,
  day text NOT NULL,
  chat_turns integer NOT NULL DEFAULT 0,
  publishes integer NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_id, day)
);

CREATE TABLE app.cloud_bindings (
  key text PRIMARY KEY,
  state text,
  resource_id text,
  version integer NOT NULL DEFAULT 0,
  fingerprint text,
  lease_token text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: 读取当前 schema 取新鲜 schemaRef**

用 `mcp_call` 调 `mcp__plugin_sites_qoder_sites__get_database_schema`，参数 `{ siteId: '01a1e421-fb71-7745-9db4-db763e874017' }`（若 stale 用 `refresh:true` + 稳定 requestId 并轮询 operation）。记录返回 `schemaRef`。确认 `tables: []`（空库）。

- [ ] **Step 3: 创建迁移计划（不应用）**

`mcp__plugin_sites_qoder_sites__create_database_migration`：
```js
{ siteId: '01a1e421-fb71-7745-9db4-db763e874017',
  requestId: '<新 UUID>', clientMigrationId: '<新 UUID>',
  displayName: 'M2 core schema (10 tables)',
  sql: '<Step 1 SQL 全文>', schemaRef: '<Step 2 schemaRef>', accessPolicies: [] }
```
审阅返回 `migration`（normalized SQL/changes）。若 `sites_migration_rejected`：按 validation_reason 修正（unsupported_type/constraint/index_option/ddl）；FK ON DELETE 被拒则去掉动作重建计划。保留意图，不重复 probe。

- [ ] **Step 4: 向用户展示计划并取得确认，然后应用**

展示 migration 摘要给用户，确认后调 `mcp__plugin_sites_qoder_sites__apply_database_migration`：
```js
{ migrationId: migration.migration_id, requestId: '<新 UUID>', planRef: reviewedPlan.planRef, confirm: true }
```
轮询 `get_operation` 至 terminal；未知结果保留原 requestId/planRef 恢复。

- [ ] **Step 5: 验证结构并记录新 schemaRef**

再调 `get_database_schema`，确认 10 张表与增列（conversations.title/last_event_id；dispatch_intents.payload_fingerprint/session_id/result；cloud_bindings）存在。记录新 `schemaRef` 供 Task 16 `prepare_site`。

- [ ] **Step 6: Commit SQL 存档**

```bash
git add functions/migrations/0001_m2.sql
git commit -m "feat(m2): reviewed restricted-subset migration for 10 core tables"
```

---

### Task 11: 前端 API 封装、SSE 消费与 chat store

**Files:**
- Create: `lib/api.ts`、`lib/sse.ts`、`store/useChatStore.ts`
- Test: `store/__tests__/chatStore.test.ts`

**Interfaces:**
- Consumes: vendored `lib/vendor/conversation-stream.mjs`、`ConstraintSetArtifact`（`shared/schemas`）、zustand
- Produces: `ApiError{code;status;diagnosticId?;details?}`；`requestJson<T>(path,opts)`；`api.{me,conversations,history,plans,plan,commit,interrupt}`；`createChatStream()`（绑定 chat store 的 reader）；`useChatStore`（state + `applyFrame`/`startSend`/`reset`/`setConversation`）；纯 reducer `reduceFrame(state,frame):ChatState`

> 状态归并（spec §2）：SSE 连接态/消息缓冲/cursor 走 Zustand；committed plan 走 TanStack Query（Task 14/15）。`applyFrame` 同步；旧 seq 不污染新视图（reset 清空）。delta 追加到同 seq 的 assistant text 消息；cursor=`<seq>:<offset>`。

- [ ] **Step 1: 写 `lib/api.ts`**

```ts
export class ApiError extends Error {
  code: string; status: number; diagnosticId?: string; details?: unknown;
  constructor(code: string, status: number, message: string, diagnosticId?: string, details?: unknown) {
    super(message); this.code = code; this.status = status; this.diagnosticId = diagnosticId; this.details = details;
  }
}
const BASE = '/functions/v1/app/api';
export async function requestJson<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal, credentials: 'same-origin',
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(e.code ?? 'service_unavailable', res.status, e.message ?? '服务暂时不可用', e.diagnostic_id, e.details);
  }
  return json as T;
}
export const api = {
  me: () => requestJson<{ visitor_id: string; quotas: { chat_remaining: number; publish_remaining: number } }>('/me'),
  conversations: () => requestJson<{ items: any[] }>('/conversations'),
  history: (id: string) => requestJson<{ conversation: any; messages: any[] }>(`/chat/history?conversation_id=${encodeURIComponent(id)}`),
  plans: () => requestJson<{ items: any[] }>('/plans'),
  plan: (id: string) => requestJson<any>(`/plans/${encodeURIComponent(id)}`),
  commit: (body: unknown) => requestJson<any>('/plans/commit', { method: 'POST', body }),
  interrupt: (id: string) => requestJson<{ ok: boolean }>('/chat/interrupt', { method: 'POST', body: { conversation_id: id } }),
};
export const SEND_URL = BASE + '/chat/send';
export const EVENTS_URL = (id: string, cursor: string) => `${BASE}/chat/events?conversation_id=${encodeURIComponent(id)}&cursor=${encodeURIComponent(cursor)}`;
```

- [ ] **Step 2: 写 `store/useChatStore.ts`**

```ts
import { create } from 'zustand';
import type { ConstraintSetArtifact } from '@/shared/schemas';
export interface ChatMessage { seq: number; role: 'user' | 'assistant' | 'system'; kind: string; content: string; payload?: unknown }
export interface ChatState {
  conversationId: string | null;
  requestId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  connection: 'idle' | 'connecting' | 'open' | 'error';
  cursor: string;
  artifact: ConstraintSetArtifact | null;
  clarifications: string[];
  error: { code: string; message: string; diagnosticId?: string } | null;
}
export interface AppFrame { event: string; data: any }
const TERMINAL = ['completed', 'failed', 'interrupted'];
export const initialChatState: ChatState = { conversationId: null, requestId: null, messages: [], streaming: false, connection: 'idle', cursor: '0:0', artifact: null, clarifications: [], error: null };
export function reduceFrame(state: ChatState, frame: AppFrame): ChatState {
  const d = frame.data;
  switch (frame.event) {
    case 'accepted': {
      const messages = state.messages.map((m) => (m.seq === -1 && m.role === 'user' ? { ...m, seq: d.seq } : m));
      return { ...state, conversationId: d.conversation_id, requestId: d.request_id, connection: 'open', streaming: true, messages, cursor: `${d.seq}:0`, error: null };
    }
    case 'delta': {
      const idx = state.messages.findIndex((m) => m.seq === d.seq && m.role === 'assistant' && m.kind === 'text');
      const messages = [...state.messages];
      if (idx >= 0) messages[idx] = { ...messages[idx], content: messages[idx].content + d.text };
      else messages.push({ seq: d.seq, role: 'assistant', kind: 'text', content: d.text });
      const content = idx >= 0 ? messages[idx].content : d.text;
      return { ...state, messages, cursor: `${d.seq}:${content.length}` };
    }
    case 'artifact': {
      const artifact = d.kind === 'constraint_set' ? (d.payload as ConstraintSetArtifact) : state.artifact;
      const clarifications = d.kind === 'constraint_set' ? (d.payload.clarifications_needed ?? []) : state.clarifications;
      return { ...state, artifact, clarifications, messages: [...state.messages, { seq: d.seq, role: 'assistant', kind: d.kind, content: '', payload: d.payload }], cursor: `${d.seq}:0` };
    }
    case 'status':
      return { ...state, streaming: !TERMINAL.includes(d.state), connection: TERMINAL.includes(d.state) ? 'idle' : state.connection };
    case 'error':
      return { ...state, streaming: false, connection: 'error', error: { code: d.code, message: d.message, diagnosticId: d.diagnostic_id } };
    case 'done':
      return { ...state, streaming: false, connection: 'idle' };
    default:
      return state;
  }
}
interface ChatStore extends ChatState {
  applyFrame: (frame: AppFrame) => void;
  startSend: (text: string) => void;
  setConversation: (id: string | null, messages?: ChatMessage[]) => void;
  reset: () => void;
}
export const useChatStore = create<ChatStore>((set, get) => ({
  ...initialChatState,
  applyFrame: (frame) => set(reduceFrame(get(), frame)),
  startSend: (text) => set({ ...get(), streaming: true, connection: 'connecting', error: null, artifact: null, clarifications: [], messages: [...get().messages, { seq: -1, role: 'user', kind: 'text', content: text }] }),
  setConversation: (id, messages = []) => set({ ...initialChatState, conversationId: id, messages }),
  reset: () => set({ ...initialChatState }),
}));
```

- [ ] **Step 3: 写 `lib/sse.ts`**

```ts
import { createConversationStream } from './vendor/conversation-stream.mjs';
import { useChatStore } from '@/store/useChatStore';
const TERMINAL = ['completed', 'failed', 'interrupted'];
export function createChatStream() {
  return createConversationStream((frame: { event: string; data: string }) => {
    const data = JSON.parse(frame.data);
    useChatStore.getState().applyFrame({ event: frame.event, data });
    return frame.event === 'done' || frame.event === 'error' || (frame.event === 'status' && TERMINAL.includes(data.state));
  });
}
```

- [ ] **Step 4: 写失败测试 `store/__tests__/chatStore.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { reduceFrame, initialChatState } from '../useChatStore';
describe('reduceFrame', () => {
  it('accepted 设定 conversationId 并把临时 user 消息 seq 转正', () => {
    const s0 = { ...initialChatState, messages: [{ seq: -1, role: 'user' as const, kind: 'text', content: 'hi' }] };
    const s = reduceFrame(s0, { event: 'accepted', data: { request_id: 'r', conversation_id: 'c', seq: 1 } });
    expect(s.conversationId).toBe('c');
    expect(s.messages[0].seq).toBe(1);
    expect(s.streaming).toBe(true);
  });
  it('delta 追加到同 seq assistant 消息并推进 cursor offset', () => {
    let s = reduceFrame(initialChatState, { event: 'delta', data: { seq: 2, text: '你' } });
    s = reduceFrame(s, { event: 'delta', data: { seq: 2, text: '好' } });
    expect(s.messages.find((m) => m.seq === 2)?.content).toBe('你好');
    expect(s.cursor).toBe('2:2');
  });
  it('artifact 设定 clarifications', () => {
    const s = reduceFrame(initialChatState, { event: 'artifact', data: { seq: 3, kind: 'constraint_set', payload: { clarifications_needed: ['每天几小时？'] } } });
    expect(s.clarifications).toEqual(['每天几小时？']);
  });
  it('error 置 connection=error 并停流', () => {
    const s = reduceFrame({ ...initialChatState, streaming: true }, { event: 'error', data: { seq: 4, code: 'quota_exceeded', message: '额度用完', diagnostic_id: 'd' } });
    expect(s.connection).toBe('error');
    expect(s.streaming).toBe(false);
    expect(s.error?.code).toBe('quota_exceeded');
  });
  it('done 停流', () => {
    const s = reduceFrame({ ...initialChatState, streaming: true }, { event: 'done', data: { seq: 5 } });
    expect(s.streaming).toBe(false);
  });
});
```

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `npx vitest run store/__tests__/chatStore.test.ts && npx tsc --noEmit`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add lib/api.ts lib/sse.ts store/useChatStore.ts store/__tests__/chatStore.test.ts
git commit -m "feat(m2): frontend api client, SSE consumer, chat store reducer"
```

---

### Task 12: 对话展示组件（MessageBubble / StreamingCursor / ChatInput）

**Files:**
- Create: `components/chat/MessageBubble.tsx`
- Create: `components/chat/StreamingCursor.tsx`
- Create: `components/chat/ChatInput.tsx`
- Create: `lib/markdown.ts`（rehype-sanitize 白名单配置，供测试与组件共用）
- Modify: `src/globals.css`（追加 `.guidy-cursor` 呼吸动画 + reduced-motion）
- Test: `components/chat/__tests__/chatInput.test.ts`
- Test: `lib/__tests__/markdown.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`（Task 11 `store/useChatStore`）；`react-markdown`、`rehype-sanitize`（Task 1 安装）；`Button`/`Textarea`（`components/ui`）；`cn`（`lib/utils`）
- Produces:
  - `MessageBubble({ message, streaming }: { message: ChatMessage; streaming?: boolean })`
  - `StreamingCursor()`（无 props）
  - `ChatInput({ streaming, disabled, onSend, onInterrupt }: { streaming: boolean; disabled?: boolean; onSend: (text: string) => void; onInterrupt: () => void })`
  - `sanitizeSchema`（rehype-sanitize 配置对象，禁 raw HTML / script / style / on* 事件）
  - `clampMessage(text: string): string`（截断到 2000 字符，纯函数）

> 安全（spec §5）：markdown 渲染必须经 `rehype-sanitize` 且 `skipHtml`，禁止 raw HTML。`clampMessage` 与 `sanitizeSchema` 抽成纯模块以便 vitest 覆盖；视觉布局用浏览器人工核验（Step 7）。

- [ ] **Step 1: 写 `lib/markdown.ts`**

```ts
import { defaultSchema } from 'rehype-sanitize';

export const MESSAGE_MAX = 2000;

export function clampMessage(text: string): string {
  return text.length > MESSAGE_MAX ? text.slice(0, MESSAGE_MAX) : text;
}

// 在默认白名单基础上进一步收紧：不允许任何 raw HTML、style、事件属性。
export const sanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => !['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'].includes(t)),
  attributes: {
    ...defaultSchema.attributes,
    '*': (defaultSchema.attributes?.['*'] ?? []).filter((a) => a !== 'style' && !String(a).startsWith('on')),
  },
  strip: ['script', 'style'],
};
```

- [ ] **Step 2: 写失败测试 `lib/__tests__/markdown.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { clampMessage, sanitizeSchema, MESSAGE_MAX } from '@/lib/markdown';

describe('clampMessage', () => {
  it('短文本原样返回', () => {
    expect(clampMessage('你好')).toBe('你好');
  });
  it('超长截断到 2000', () => {
    const s = clampMessage('a'.repeat(MESSAGE_MAX + 50));
    expect(s.length).toBe(MESSAGE_MAX);
  });
});

describe('sanitizeSchema', () => {
  it('禁止 script/style/iframe 标签', () => {
    expect(sanitizeSchema.tagNames).not.toContain('script');
    expect(sanitizeSchema.tagNames).not.toContain('style');
    expect(sanitizeSchema.tagNames).not.toContain('iframe');
  });
  it('通配属性不含 style 与 on* 事件', () => {
    const star = sanitizeSchema.attributes['*'] as string[];
    expect(star).not.toContain('style');
    expect(star.some((a) => String(a).startsWith('on'))).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run lib/__tests__/markdown.test.ts`
Expected: FAIL（`@/lib/markdown` 不存在）。

- [ ] **Step 4: 写 `components/chat/MessageBubble.tsx`**

```tsx
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { Sparkles } from 'lucide-react';
import type { ChatMessage } from '@/store/useChatStore';
import { sanitizeSchema } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { StreamingCursor } from './StreamingCursor';

export function MessageBubble({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  if (message.kind === 'constraint_set' || message.kind === 'patch') {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-[var(--site-dawn-line)]/30 bg-[var(--site-dawn-soft)] px-3 py-2 text-xs text-site-ink">
        <Sparkles className="h-3.5 w-3.5 text-[var(--site-dawn-line)]" />
        {message.kind === 'constraint_set' ? '已生成约束方案，请在下方确认卡核对' : '已生成调整建议'}
      </div>
    );
  }
  if (message.role === 'system' || message.kind === 'status' || message.kind === 'error') {
    return <p className="px-1 text-center text-[11px] text-site-ink-soft">{message.content}</p>;
  }
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
          isUser ? 'bg-site-brand text-white' : 'border border-site-line bg-site-surface text-site-ink',
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <div className="guidy-prose break-words">
            <ReactMarkdown rehypePlugins={[[rehypeSanitize, sanitizeSchema]]} skipHtml>
              {message.content}
            </ReactMarkdown>
            {streaming && <StreamingCursor />}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 写 `components/chat/StreamingCursor.tsx`**

```tsx
export function StreamingCursor() {
  return <span className="guidy-cursor ml-0.5 inline-block h-4 w-0.5 align-text-bottom" aria-hidden="true" />;
}
```

在 `src/globals.css` 末尾追加（dawn 渐变竖条 + 1s 呼吸；reduced-motion 常亮）：

```css
.guidy-cursor {
  background: linear-gradient(180deg, var(--site-dawn-line), var(--site-brand));
  animation: guidy-cursor-breathe 1s ease-in-out infinite;
}
@keyframes guidy-cursor-breathe {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .guidy-cursor { animation: none; opacity: 1; }
}
.guidy-prose :where(p, ul, ol) { margin: 0.25rem 0; }
.guidy-prose :where(ul, ol) { padding-left: 1.1rem; }
.guidy-prose :where(code) { font-size: 0.85em; background: var(--site-surface-2); padding: 0 0.25rem; border-radius: 0.25rem; }
```

- [ ] **Step 6: 写 `components/chat/ChatInput.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { clampMessage, MESSAGE_MAX } from '@/lib/markdown';
import { cn } from '@/lib/utils';

export function ChatInput({ streaming, disabled, onSend, onInterrupt }: {
  streaming: boolean; disabled?: boolean; onSend: (text: string) => void; onInterrupt: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === '/' && !target.closest('input, textarea, select, [contenteditable]')) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = () => {
    const t = clampMessage(text.trim());
    if (!t || streaming || disabled) return;
    onSend(t);
    setText('');
  };

  return (
    <div className="border-t border-site-line bg-site-bg p-3">
      <div className="relative rounded-xl border border-site-line bg-site-surface focus-within:border-site-brand">
        <Textarea
          ref={ref}
          value={text}
          rows={2}
          maxLength={MESSAGE_MAX}
          disabled={disabled}
          placeholder={streaming ? 'Guidy 正在生成…' : '说说你的安排，例如「周三晚兼职，数学英语别连着学」（/ 聚焦）'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          className="max-h-40 min-h-[52px] resize-none border-0 bg-transparent pr-12 shadow-none focus-visible:ring-0"
          aria-label="对话输入"
        />
        <div className="absolute bottom-2 right-2 flex items-center gap-2">
          <span className={cn('tabular text-[10px]', text.length > MESSAGE_MAX - 100 ? 'text-site-danger' : 'text-site-ink-soft')}>
            {text.length}/{MESSAGE_MAX}
          </span>
          {streaming ? (
            <Button size="icon" variant="outline" className="h-8 w-8" aria-label="中断生成" onClick={onInterrupt}>
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button size="icon" className="h-8 w-8" aria-label="发送" disabled={!text.trim() || disabled} onClick={submit}>
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: 写失败测试 `components/chat/__tests__/chatInput.test.ts`（纯逻辑：clamp 边界）**

```ts
import { describe, expect, it } from 'vitest';
import { clampMessage, MESSAGE_MAX } from '@/lib/markdown';

describe('ChatInput 提交前 clamp', () => {
  it('恰好 2000 字符不截断', () => {
    const s = 'b'.repeat(MESSAGE_MAX);
    expect(clampMessage(s).length).toBe(MESSAGE_MAX);
  });
  it('2001 字符截断到 2000', () => {
    expect(clampMessage('b'.repeat(MESSAGE_MAX + 1)).length).toBe(MESSAGE_MAX);
  });
});
```

- [ ] **Step 8: 运行测试 + 类型检查**

Run: `npx vitest run lib/__tests__/markdown.test.ts components/chat/__tests__/chatInput.test.ts && npx tsc --noEmit`
Expected: 全绿。

- [ ] **Step 9: 浏览器人工核验（视觉）**

Run: `npm run dev`，在 ChatPanel 接入后（Task 14）核验：用户气泡右对齐品牌色、助手气泡左对齐暖纸底、流式时 dawn 竖条呼吸、系统开启「减少动态效果」后竖条常亮、输入框 `/` 聚焦、Enter 发送 / Shift+Enter 换行、超 2000 字符计数变红且无法再输入、流式时显示中断按钮。本任务先确保组件编译通过；完整交互在 Task 14 联调。

- [ ] **Step 10: Commit**

```bash
git add components/chat/MessageBubble.tsx components/chat/StreamingCursor.tsx components/chat/ChatInput.tsx lib/markdown.ts src/globals.css components/chat/__tests__/chatInput.test.ts lib/__tests__/markdown.test.ts
git commit -m "feat(m2): chat message bubble, streaming cursor, input with sanitize"
```

---

### Task 13: 约束确认卡（ConstraintConfirmCard + 草稿 reducer + 焦点陷阱）

**Files:**
- Create: `lib/confirmDraft.ts`（纯函数：删除/补充约束、mutex 软↔硬、改任务时长/标题、改时间窗）
- Create: `lib/useFocusTrap.ts`（dialog 焦点陷阱 hook）
- Create: `components/chat/ConstraintConfirmCard.tsx`
- Test: `lib/__tests__/confirmDraft.test.ts`

**Interfaces:**
- Consumes: `ConstraintSetArtifact`/`ConstraintPayload`/`TaskDef`（`shared/schemas`）；`constraintText`（`lib/describe`）；`Button`/`Input`/`Select` 等（`components/ui`）
- Produces:
  - `removeConstraint(draft, index): ConstraintSetArtifact`
  - `addDefaultConstraint(draft): ConstraintSetArtifact`（追加 `{type:'active_window',start:'08:00',end:'22:00'}`）
  - `toggleMutexStrength(draft, index): ConstraintSetArtifact`（soft↔hard，非 mutex 原样返回）
  - `updateTaskDuration(draft, key, minutes): ConstraintSetArtifact`
  - `updateTaskTitle(draft, key, title): ConstraintSetArtifact`
  - `updateWindow(draft, index, field: 'start'|'end', value): ConstraintSetArtifact`（仅 busy_window/active_window/fixed_block）
  - `useFocusTrap(ref: RefObject<HTMLElement|null>, active: boolean, onEscape: () => void): void`
  - `ConstraintConfirmCard({ artifact, onConfirm, onCancel }: { artifact: ConstraintSetArtifact; onConfirm: (draft: ConstraintSetArtifact) => void; onCancel: () => void })`

> 交互（spec §2）：`clarifications_needed` 非空时**不出卡**（由 ChatPanel 先渲染追问，Task 14）；出卡后用户逐条编辑/删除/补充 → 点 [确认并生成] 把草稿交给 Task 15 做本地 solve 预览。所有编辑都是不可变纯函数，便于 vitest 覆盖；焦点陷阱/视觉用浏览器核验。

- [ ] **Step 1: 写失败测试 `lib/__tests__/confirmDraft.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  removeConstraint, addDefaultConstraint, toggleMutexStrength,
  updateTaskDuration, updateTaskTitle, updateWindow,
} from '@/lib/confirmDraft';
import type { ConstraintSetArtifact } from '@/shared/schemas';

const base: ConstraintSetArtifact = {
  type: 'constraint_set', plan_title: '考研', horizon_days: 7,
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [
    { type: 'active_window', start: '07:00', end: '23:00' },
    { type: 'mutex', subjects: { kind: 'category', values: ['study', 'fitness'] }, mode: 'no_adjacent', strength: 'soft' },
  ],
  clarifications_needed: [],
};

describe('confirmDraft', () => {
  it('removeConstraint 删除指定下标且不改原对象', () => {
    const next = removeConstraint(base, 0);
    expect(next.constraints.length).toBe(1);
    expect(next.constraints[0].type).toBe('mutex');
    expect(base.constraints.length).toBe(2);
  });
  it('addDefaultConstraint 追加 active_window', () => {
    const next = addDefaultConstraint(base);
    expect(next.constraints.length).toBe(3);
    expect(next.constraints[2]).toEqual({ type: 'active_window', start: '08:00', end: '22:00' });
  });
  it('toggleMutexStrength soft→hard→soft', () => {
    const hard = toggleMutexStrength(base, 1);
    expect((hard.constraints[1] as any).strength).toBe('hard');
    expect((toggleMutexStrength(hard, 1).constraints[1] as any).strength).toBe('soft');
  });
  it('toggleMutexStrength 对非 mutex 原样返回', () => {
    expect(toggleMutexStrength(base, 0)).toEqual(base);
  });
  it('updateTaskDuration 改时长', () => {
    expect(updateTaskDuration(base, 'math', 120).task_defs[0].duration_min).toBe(120);
  });
  it('updateTaskTitle 改标题', () => {
    expect(updateTaskTitle(base, 'math', '数学真题').task_defs[0].title).toBe('数学真题');
  });
  it('updateWindow 改 active_window 时间', () => {
    const next = updateWindow(base, 0, 'end', '22:00');
    expect((next.constraints[0] as any).end).toBe('22:00');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run lib/__tests__/confirmDraft.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `lib/confirmDraft.ts`**

```ts
import type { ConstraintSetArtifact, ConstraintPayload } from '@/shared/schemas';

const WINDOW_TYPES = ['busy_window', 'active_window', 'fixed_block'];

export function removeConstraint(draft: ConstraintSetArtifact, index: number): ConstraintSetArtifact {
  return { ...draft, constraints: draft.constraints.filter((_, i) => i !== index) };
}

export function addDefaultConstraint(draft: ConstraintSetArtifact): ConstraintSetArtifact {
  const next: ConstraintPayload = { type: 'active_window', start: '08:00', end: '22:00' };
  return { ...draft, constraints: [...draft.constraints, next] };
}

export function toggleMutexStrength(draft: ConstraintSetArtifact, index: number): ConstraintSetArtifact {
  const c = draft.constraints[index];
  if (!c || c.type !== 'mutex') return draft;
  const strength = c.strength === 'soft' ? 'hard' : 'soft';
  const constraints = draft.constraints.map((x, i) => (i === index ? { ...c, strength } : x));
  return { ...draft, constraints };
}

export function updateTaskDuration(draft: ConstraintSetArtifact, key: string, minutes: number): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.map((t) => (t.key === key ? { ...t, duration_min: minutes } : t)) };
}

export function updateTaskTitle(draft: ConstraintSetArtifact, key: string, title: string): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.map((t) => (t.key === key ? { ...t, title } : t)) };
}

export function updateWindow(draft: ConstraintSetArtifact, index: number, field: 'start' | 'end', value: string): ConstraintSetArtifact {
  const c = draft.constraints[index];
  if (!c || !WINDOW_TYPES.includes(c.type)) return draft;
  const constraints = draft.constraints.map((x, i) => (i === index ? { ...c, [field]: value } : x));
  return { ...draft, constraints };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run lib/__tests__/confirmDraft.test.ts`
Expected: PASS（7 例）。

- [ ] **Step 5: 写 `lib/useFocusTrap.ts`**

```ts
import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;
    const items = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
      if (e.key !== 'Tab') return;
      const list = items();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    node.addEventListener('keydown', onKey);
    return () => { node.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [ref, active, onEscape]);
}
```

- [ ] **Step 6: 写 `components/chat/ConstraintConfirmCard.tsx`**

```tsx
import { useRef, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { constraintText } from '@/lib/describe';
import {
  removeConstraint, addDefaultConstraint, toggleMutexStrength,
  updateTaskDuration, updateTaskTitle, updateWindow,
} from '@/lib/confirmDraft';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const WINDOW_TYPES = ['busy_window', 'active_window', 'fixed_block'];

export function ConstraintConfirmCard({ artifact, onConfirm, onCancel }: {
  artifact: ConstraintSetArtifact; onConfirm: (draft: ConstraintSetArtifact) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ConstraintSetArtifact>(artifact);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onCancel);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="确认约束方案"
      className="animate-guidy-fade-up rounded-xl border border-[var(--site-dawn-line)]/40 bg-site-surface p-4 shadow-sm"
    >
      <div className="dawn-gradient mb-3 h-0.5 rounded-full" />
      <h3 className="font-display text-sm font-semibold text-site-ink">核对约束方案</h3>
      <p className="mt-0.5 text-xs text-site-ink-soft">逐条确认或修改，再生成计划预览。</p>

      <section className="mt-3">
        <h4 className="mb-1.5 text-xs font-semibold text-site-ink">任务（{draft.task_defs.length}）</h4>
        <ul className="space-y-1.5">
          {draft.task_defs.map((t) => (
            <li key={t.key} className="flex items-center gap-2 rounded-lg border border-site-line bg-site-bg px-2.5 py-1.5">
              <Input
                value={t.title}
                aria-label={`任务标题 ${t.key}`}
                onChange={(e) => setDraft((d) => updateTaskTitle(d, t.key, e.target.value.slice(0, 60)))}
                className="h-7 flex-1 text-xs"
              />
              <Input
                type="number" min={15} max={480} value={t.duration_min}
                aria-label={`任务时长 ${t.key}`}
                onChange={(e) => setDraft((d) => updateTaskDuration(d, t.key, Math.max(15, Math.min(480, Number(e.target.value) || 15))))}
                className="tabular h-7 w-20 text-xs"
              />
              <span className="text-[10px] text-site-ink-soft">分钟</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <h4 className="text-xs font-semibold text-site-ink">约束（{draft.constraints.length}）</h4>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setDraft((d) => addDefaultConstraint(d))}>
            <Plus className="mr-0.5 h-3 w-3" /> 补充
          </Button>
        </div>
        <ul className="space-y-1.5">
          {draft.constraints.map((c, i) => (
            <li key={i} className="rounded-lg border border-site-line bg-site-bg px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-xs leading-snug text-site-ink">{constraintText(c)}</span>
                {c.type === 'mutex' && (
                  <button
                    type="button"
                    onClick={() => setDraft((d) => toggleMutexStrength(d, i))}
                    className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', c.strength === 'hard' ? 'bg-site-danger/10 text-site-danger' : 'bg-site-surface-2 text-site-ink-soft')}
                    aria-label={`互斥强度切换，当前${c.strength === 'hard' ? '硬' : '软'}`}
                  >
                    {c.strength === 'hard' ? '硬性' : '软性'}
                  </button>
                )}
                <button type="button" aria-label="删除约束" className="rounded p-1 text-site-ink-soft hover:text-site-danger" onClick={() => setDraft((d) => removeConstraint(d, i))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {WINDOW_TYPES.includes(c.type) && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Input type="time" value={(c as any).start} aria-label="开始时间" onChange={(e) => setDraft((d) => updateWindow(d, i, 'start', e.target.value))} className="h-7 w-28 text-xs" />
                  <span className="text-xs text-site-ink-soft">至</span>
                  <Input type="time" value={(c as any).end} aria-label="结束时间" onChange={(e) => setDraft((d) => updateWindow(d, i, 'end', e.target.value))} className="h-7 w-28 text-xs" />
                </div>
              )}
            </li>
          ))}
          {draft.constraints.length === 0 && (
            <li className="rounded-lg border border-dashed border-site-line p-2.5 text-center text-xs text-site-ink-soft">无约束，点「补充」添加</li>
          )}
        </ul>
      </section>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" className="dawn-gradient text-white" disabled={draft.task_defs.length === 0} onClick={() => onConfirm(draft)}>
          <Check className="mr-1 h-4 w-4" /> 确认并生成
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过（`constraintText(c)` 单参调用合法，第二参可选）。

- [ ] **Step 8: 浏览器人工核验（Task 14 联调后）**

核验：卡片 `role=dialog`、打开时焦点落在首个可聚焦元素、Tab/Shift+Tab 在卡内循环、Esc 触发 onCancel 且焦点回到触发元素；mutex 软↔硬切换文案与配色变化；删除/补充/改时长/改时间窗即时生效；task_defs 为空时 [确认并生成] 禁用。

- [ ] **Step 9: Commit**

```bash
git add lib/confirmDraft.ts lib/useFocusTrap.ts components/chat/ConstraintConfirmCard.tsx lib/__tests__/confirmDraft.test.ts
git commit -m "feat(m2): constraint confirm card with draft reducers and focus trap"
```

---

### Task 14: 前端预览与 commit（本地 solve 预览 + TanStack 乐观回滚）

**Files:**
- Create: `lib/preview.ts`（纯函数 `solveArtifact`：artifact → 本地 solve + diff）
- Create: `lib/commitInput.ts`（纯函数 `buildCommitInput`：组装 commit body + result_hash）
- Create: `lib/useCommitPlan.ts`（TanStack `useMutation`：乐观应用预览、失败回滚保留预览、成功以服务端为准）
- Modify: `store/usePlanStore.ts`（新增 `previewArtifact(draft)` action）
- Test: `lib/__tests__/preview.test.ts`
- Test: `lib/__tests__/commitInput.test.ts`

**Interfaces:**
- Consumes: `solve`/`diffBlocks`/`resultHash`（`shared/engine`）；`ENGINE_VERSION`（`shared/constants`）；`ConstraintSetArtifact`/`TaskDef`/`Constraint`（`shared/schemas`）；`Block`/`SolveOutput`/`DiffResult`/`PlanState`（`shared/types`）；`api.commit`/`ApiError`（Task 11）；`usePlanStore`（M1）
- Produces:
  - `solveArtifact(draft: ConstraintSetArtifact, plan: { horizon_start: string; timezone: string }, blocks: Block[]): { output: SolveOutput; diff: DiffResult }`
  - `CommitBody`（`{preview_id; plan_id: string|null; input: {title;horizon_start;horizon_days;timezone;task_defs;constraints}; result_hash; engine_version}`）
  - `buildCommitInput(args: { draft: ConstraintSetArtifact; plan: { horizon_start: string; timezone: string }; blocks: Block[]; previewId: string; planId: string|null }): Promise<CommitBody>`
  - `usePlanStore.previewArtifact(draft: ConstraintSetArtifact): void`（设置 `preview`/`lastCompromises`）
  - `useCommitPlan(): { commit: (draft: ConstraintSetArtifact) => void; isPending: boolean; error: ApiError|null }`

> 数据流（spec §2/§3）：确认卡 onConfirm → `previewArtifact` 本地 solve 出 ghost/diff（复用 M1 `preview` 态）→ 用户确认预览 → `useCommitPlan.commit` 组装 body（前端算 `result_hash`）→ POST /plans/commit。乐观更新：先本地 `applyPreview`，失败回滚到快照并**保留预览**；成功 `importState(服务端 plan)` 并清空示例。服务端 `server_authoritative:true` 时以返回 blocks 为准（onSuccess 统一 importState）。`constraints` 提交为带 id 的 `Constraint[]`（与契约 §6.2 一致）。

- [ ] **Step 1: 写失败测试 `lib/__tests__/preview.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { solveArtifact } from '@/lib/preview';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { Block } from '@/shared/types';

const draft: ConstraintSetArtifact = {
  type: 'constraint_set', plan_title: '考研', horizon_days: 7,
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [{ type: 'active_window', start: '08:00', end: '22:00' }],
  clarifications_needed: [],
};
const plan = { horizon_start: '2026-11-16T00:00:00.000Z', timezone: 'Asia/Shanghai' };

describe('solveArtifact', () => {
  it('产出非空 blocks 且 diff 相对空 blocks 全为 added', () => {
    const { output, diff } = solveArtifact(draft, plan, [] as Block[]);
    expect(output.blocks.length).toBeGreaterThan(0);
    expect(diff.added.length).toBe(output.blocks.length);
  });
  it('保留钉住块', () => {
    const pinned: Block = { id: 'p1', title: '固定', category: 'work', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:00:00.000Z', priority: 'mid', pinned: true, origin: 'manual' };
    const { output } = solveArtifact(draft, plan, [pinned]);
    expect(output.blocks.some((b) => b.id === 'p1')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run lib/__tests__/preview.test.ts`
Expected: FAIL（`@/lib/preview` 不存在）。

- [ ] **Step 3: 写 `lib/preview.ts`**

```ts
import { ENGINE_VERSION } from '@/shared/constants';
import { diffBlocks, solve } from '@/shared/engine';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { Block, Constraint, DiffResult, SolveOutput } from '@/shared/types';

export function solveArtifact(
  draft: ConstraintSetArtifact,
  plan: { horizon_start: string; timezone: string },
  blocks: Block[],
): { output: SolveOutput; diff: DiffResult } {
  const constraints: Constraint[] = draft.constraints.map((payload, i) => ({
    id: `ai-${i}`, payload, source: 'ai', enabled: true,
  }));
  const pinned = blocks.filter((b) => b.pinned || b.origin === 'manual');
  const output = solve({
    engine_version: ENGINE_VERSION,
    horizon_start: plan.horizon_start,
    horizon_days: draft.horizon_days,
    timezone: plan.timezone,
    task_defs: draft.task_defs,
    constraints,
    pinned_blocks: pinned,
  });
  return { output, diff: diffBlocks(blocks, output.blocks) };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run lib/__tests__/preview.test.ts`
Expected: PASS（2 例）。

- [ ] **Step 5: 写失败测试 `lib/__tests__/commitInput.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { buildCommitInput } from '@/lib/commitInput';
import { solveArtifact } from '@/lib/preview';
import { resultHash } from '@/shared/engine';
import { ENGINE_VERSION } from '@/shared/constants';
import type { ConstraintSetArtifact } from '@/shared/schemas';

const draft: ConstraintSetArtifact = {
  type: 'constraint_set', plan_title: '考研', horizon_days: 7,
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [{ type: 'active_window', start: '08:00', end: '22:00' }],
  clarifications_needed: [],
};
const plan = { horizon_start: '2026-11-16T00:00:00.000Z', timezone: 'Asia/Shanghai' };

describe('buildCommitInput', () => {
  it('body 字段齐全且 result_hash 与服务端算法一致', async () => {
    const { output } = solveArtifact(draft, plan, []);
    const body = await buildCommitInput({ draft, plan, blocks: output.blocks, previewId: 'pv-1', planId: null });
    expect(body.preview_id).toBe('pv-1');
    expect(body.plan_id).toBeNull();
    expect(body.engine_version).toBe(ENGINE_VERSION);
    expect(body.input.title).toBe('考研');
    expect(body.input.horizon_days).toBe(7);
    expect(body.input.timezone).toBe('Asia/Shanghai');
    expect(body.input.constraints[0].id).toBe('ai-0');
    expect(body.result_hash).toBe(await resultHash(output.blocks));
  });
});
```

- [ ] **Step 6: 写 `lib/commitInput.ts`**

```ts
import { ENGINE_VERSION } from '@/shared/constants';
import { resultHash } from '@/shared/engine';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { Block, Constraint } from '@/shared/types';

export interface CommitBody {
  preview_id: string;
  plan_id: string | null;
  input: {
    title: string;
    horizon_start: string;
    horizon_days: number;
    timezone: string;
    task_defs: ConstraintSetArtifact['task_defs'];
    constraints: Constraint[];
  };
  result_hash: string;
  engine_version: number;
}

export async function buildCommitInput(args: {
  draft: ConstraintSetArtifact;
  plan: { horizon_start: string; timezone: string };
  blocks: Block[];
  previewId: string;
  planId: string | null;
}): Promise<CommitBody> {
  const { draft, plan, blocks, previewId, planId } = args;
  const constraints: Constraint[] = draft.constraints.map((payload, i) => ({
    id: `ai-${i}`, payload, source: 'ai', enabled: true,
  }));
  return {
    preview_id: previewId,
    plan_id: planId,
    input: {
      title: draft.plan_title,
      horizon_start: plan.horizon_start,
      horizon_days: draft.horizon_days,
      timezone: plan.timezone,
      task_defs: draft.task_defs,
      constraints,
    },
    result_hash: await resultHash(blocks),
    engine_version: ENGINE_VERSION,
  };
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run lib/__tests__/commitInput.test.ts`
Expected: PASS。

- [ ] **Step 8: 修改 `store/usePlanStore.ts` 增加 `previewArtifact`**

在 `PlanStore` 接口中 `requestReschedule` 声明之后加入：

```ts
  previewArtifact: (draft: import('@/shared/schemas').ConstraintSetArtifact) => void;
```

在文件顶部 import 区加入：

```ts
import { solveArtifact } from '@/lib/preview';
```

在 `requestReschedule` 实现之后加入实现：

```ts
    previewArtifact: (draft) => {
      const { state } = get();
      const { output, diff } = solveArtifact(draft, { horizon_start: state.plan.horizon_start, timezone: state.plan.timezone }, state.blocks);
      set({ preview: { output, diff, reason: 'AI 约束方案预览' }, lastCompromises: output.compromises });
    },
```

- [ ] **Step 9: 写 `lib/useCommitPlan.ts`**

```ts
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { buildCommitInput } from '@/lib/commitInput';
import { usePlanStore } from '@/store/usePlanStore';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';

export function useCommitPlan() {
  const mutation = useMutation({
    mutationFn: async (draft: ConstraintSetArtifact) => {
      const store = usePlanStore.getState();
      const preview = store.preview;
      if (!preview) throw new ApiError('validation_failed', 422, '请先生成预览');
      const body = await buildCommitInput({
        draft,
        plan: { horizon_start: store.state.plan.horizon_start, timezone: store.state.plan.timezone },
        blocks: preview.output.blocks,
        previewId: crypto.randomUUID(),
        planId: store.state.plan.id ?? null,
      });
      return api.commit(body);
    },
    onMutate: async () => {
      const store = usePlanStore.getState();
      const snapshot = JSON.parse(JSON.stringify(store.state)) as PlanState;
      const hadPreview = store.preview;
      store.applyPreview();
      return { snapshot, hadPreview };
    },
    onError: (err, _draft, ctx) => {
      const store = usePlanStore.getState();
      if (ctx?.snapshot) store.importState(ctx.snapshot);
      if (ctx?.hadPreview) usePlanStore.setState({ preview: ctx.hadPreview });
      const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, '提交失败，请重试');
      toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
    },
    onSuccess: (serverPlan: any) => {
      const store = usePlanStore.getState();
      const next: PlanState = {
        plan: serverPlan.plan,
        task_defs: serverPlan.task_defs,
        constraints: serverPlan.constraints,
        blocks: serverPlan.blocks,
      };
      store.importState(next);
      usePlanStore.setState({ preview: null });
      toast.success(serverPlan.server_authoritative ? '已按服务端结果保存计划' : '计划已保存到云端');
    },
  });
  return {
    commit: (draft: ConstraintSetArtifact) => mutation.mutate(draft),
    isPending: mutation.isPending,
    error: mutation.error instanceof ApiError ? mutation.error : null,
  };
}
```

> 注：`api.commit` 返回服务端 plan 包络。Task 8 的 `commitPlan` 成功响应形如 `{plan, blocks, task_defs, constraints, server_authoritative}`；`onSuccess` 需把它还原成 `PlanState`。为避免前端猜测包络，Task 8 成功响应**直接返回完整 `PlanState` 形状**（`{plan, task_defs, constraints, blocks}`）外加 `server_authoritative` 字段；`importState` 消费 `{plan,task_defs,constraints,blocks}`。`importState`（M1 `usePlanStore.ts:264`）已把 `isSample` 置 false 并重置 undo/redo，故无需再调 `clearSample`。Task 8 成功响应是 `PlanState` 超集，`onSuccess` 取 `{plan,task_defs,constraints,blocks}` 四字段构造即可。

- [ ] **Step 10: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全绿（M1 33 例 + M2 新增）。

- [ ] **Step 11: Commit**

```bash
git add lib/preview.ts lib/commitInput.ts lib/useCommitPlan.ts store/usePlanStore.ts lib/__tests__/preview.test.ts lib/__tests__/commitInput.test.ts
git commit -m "feat(m2): artifact preview, commit input builder, optimistic commit mutation"
```

---

### Task 15: 对话编排与布局集成（chatController / ChatPanel / App 外壳）

**Files:**
- Create: `lib/chatController.ts`（纯编排：send/resume/interrupt/newConversation，注入 fetch/stream/store，可 vitest）
- Create: `lib/useChat.ts`（React hook：持有 stream 实例 + controller，卸载取消）
- Create: `components/chat/ChatPanel.tsx`（左栏容器：消息流、追问、确认卡、预览确认条、输入）
- Modify: `src/App.tsx`（左栏 OverviewPanel → ChatPanel；移动 Tab 对话/日历）
- Modify: `store/useUiStore.ts`（`MobileTab = 'chat' | 'calendar'`，默认 `'chat'`）
- Modify: `components/workbench/TopBar.tsx`（新增约束/任务抽屉入口按钮）
- Modify: `src/main.tsx`（`QueryClientProvider`）
- Delete: `components/workbench/OverviewPanel.tsx`（职责迁入 ChatPanel 问候 + 抽屉）
- Test: `lib/__tests__/chatController.test.ts`

**Interfaces:**
- Consumes: `useChatStore`/`ChatMessage`（Task 11）；`createChatStream`（Task 11 `lib/sse`）；`SEND_URL`/`EVENTS_URL`/`ApiError`/`api`（Task 11）；`MessageBubble`/`ChatInput`（Task 12）；`ConstraintConfirmCard`（Task 13）；`useCommitPlan`（Task 14）；`usePlanStore.previewArtifact`（Task 14）；`@tanstack/react-query`（Task 1）
- Produces:
  - `ChatStream`（`{cancel():void; read(open:(signal:AbortSignal)=>Promise<Response>):Promise<void>}`）
  - `createChatController(deps:{store:typeof useChatStore; stream:ChatStream; fetchFn?:typeof fetch; newId?:()=>string}):{send(text:string):void; resume():void; interrupt():void; newConversation():void}`
  - `useChat():ReturnType<typeof createChatController>`
  - `ChatPanel()`（无 props）

> 编排（spec §3）：send 先 `startSend`（临时 user 消息 seq=-1）再 `stream.read` 打开 POST /chat/send（body `{conversation_id?, text, request_id}`）；非 2xx 在打开阶段解析错误包络并 `applyFrame(error)`，不进入 SSE 消费。resume 仅 GET /chat/events?cursor（刷新零 POST）。interrupt 取消上游读取 + 本地投影 interrupted + POST /chat/interrupt。newConversation 取消旧 reader + reset（旧 seq 不污染新视图）。`request_id` 客户端 `crypto.randomUUID()` 保证幂等。

- [ ] **Step 1: 写失败测试 `lib/__tests__/chatController.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatController, type ChatStream } from '@/lib/chatController';
import { useChatStore } from '@/store/useChatStore';

function fakeStream(): ChatStream & { opened: ((signal: AbortSignal) => Promise<Response>)[] } {
  const opened: ((signal: AbortSignal) => Promise<Response>)[] = [];
  return { opened, cancel: vi.fn(), read: async (open) => { opened.push(open); await open(new AbortController().signal); } };
}

beforeEach(() => useChatStore.getState().reset());

describe('chatController.send', () => {
  it('成功：POST body 含 text/request_id，stream 被打开', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async () => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-1' });
    c.send('周三晚兼职');
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain('/chat/send');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ text: '周三晚兼职', request_id: 'req-1' });
    expect(useChatStore.getState().streaming).toBe(true);
  });
  it('429：解析错误包络写入 store.error，不消费 SSE', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 'quota_exceeded', message: '额度用完' } }) }) as unknown as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-2' });
    c.send('hi');
    await new Promise((r) => setTimeout(r, 0));
    expect(useChatStore.getState().error?.code).toBe('quota_exceeded');
    expect(useChatStore.getState().streaming).toBe(false);
  });
});

describe('chatController.interrupt / newConversation', () => {
  it('interrupt 取消 stream 并投影 interrupted', () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response);
    useChatStore.getState().setConversation('c1');
    const c = createChatController({ store: useChatStore, stream, fetchFn });
    c.interrupt();
    expect(stream.cancel).toHaveBeenCalled();
    expect(useChatStore.getState().streaming).toBe(false);
  });
  it('newConversation 取消旧 reader 并清空消息', () => {
    const stream = fakeStream();
    useChatStore.getState().setConversation('c1', [{ seq: 1, role: 'user', kind: 'text', content: 'old' }]);
    const c = createChatController({ store: useChatStore, stream, fetchFn: vi.fn() });
    c.newConversation();
    expect(stream.cancel).toHaveBeenCalled();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().conversationId).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run lib/__tests__/chatController.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `lib/chatController.ts`**

```ts
import { ApiError, EVENTS_URL, SEND_URL } from '@/lib/api';
import { useChatStore } from '@/store/useChatStore';

export interface ChatStream {
  cancel(): void;
  read(open: (signal: AbortSignal) => Promise<Response>): Promise<void>;
}

const API_BASE = '/functions/v1/app/api';

async function openChecked(
  fetchFn: typeof fetch, url: string, init: RequestInit, store: typeof useChatStore,
): Promise<Response> {
  const res = await fetchFn(url, init);
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    const e = j?.error ?? {};
    store.getState().applyFrame({ event: 'error', data: { seq: 0, code: e.code ?? 'service_unavailable', message: e.message ?? '服务暂时不可用', diagnostic_id: e.diagnostic_id } });
    throw new ApiError(e.code ?? 'service_unavailable', res.status, e.message ?? '服务暂时不可用', e.diagnostic_id);
  }
  return res;
}

export function createChatController(deps: {
  store: typeof useChatStore; stream: ChatStream; fetchFn?: typeof fetch; newId?: () => string;
}) {
  const store = deps.store;
  const stream = deps.stream;
  const fetchFn = deps.fetchFn ?? fetch;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  return {
    send(text: string) {
      const st = store.getState();
      st.startSend(text);
      const body = { conversation_id: st.conversationId ?? undefined, text, request_id: newId() };
      stream.read((signal) => openChecked(fetchFn, SEND_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal, credentials: 'same-origin',
      }, store)).catch(() => {});
    },
    resume() {
      const st = store.getState();
      if (!st.conversationId) return;
      stream.read((signal) => openChecked(fetchFn, EVENTS_URL(st.conversationId, st.cursor), {
        signal, credentials: 'same-origin',
      }, store)).catch(() => {});
    },
    interrupt() {
      const st = store.getState();
      stream.cancel();
      st.applyFrame({ event: 'status', data: { seq: 0, state: 'interrupted' } });
      if (st.conversationId) {
        fetchFn(`${API_BASE}/chat/interrupt`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversation_id: st.conversationId }), credentials: 'same-origin',
        }).catch(() => {});
      }
    },
    newConversation() {
      stream.cancel();
      store.getState().reset();
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run lib/__tests__/chatController.test.ts`
Expected: PASS（4 例）。

- [ ] **Step 5: 写 `lib/useChat.ts`**

```ts
import { useEffect, useMemo, useRef } from 'react';
import { createChatStream } from '@/lib/sse';
import { createChatController, type ChatStream } from '@/lib/chatController';
import { useChatStore } from '@/store/useChatStore';

export function useChat() {
  const streamRef = useRef<ChatStream | null>(null);
  if (!streamRef.current) streamRef.current = createChatStream() as ChatStream;
  const controller = useMemo(() => createChatController({ store: useChatStore, stream: streamRef.current! }), []);
  useEffect(() => () => streamRef.current?.cancel(), []);
  return controller;
}
```

- [ ] **Step 6: 写 `components/chat/ChatPanel.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MessageSquarePlus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useChat } from '@/lib/useChat';
import { useChatStore } from '@/store/useChatStore';
import { usePlanStore } from '@/store/usePlanStore';
import { useCommitPlan } from '@/lib/useCommitPlan';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { Button } from '@/components/ui/button';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { ConstraintConfirmCard } from './ConstraintConfirmCard';

export function ChatPanel() {
  const chat = useChat();
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const connection = useChatStore((s) => s.connection);
  const artifact = useChatStore((s) => s.artifact);
  const clarifications = useChatStore((s) => s.clarifications);
  const error = useChatStore((s) => s.error);
  const conversationId = useChatStore((s) => s.conversationId);
  const setConversation = useChatStore((s) => s.setConversation);

  const isSample = usePlanStore((s) => s.isSample);
  const clearSample = usePlanStore((s) => s.clearSample);
  const preview = usePlanStore((s) => s.preview);
  const previewArtifact = usePlanStore((s) => s.previewArtifact);
  const discardPreview = usePlanStore((s) => s.discardPreview);
  const { commit, isPending } = useCommitPlan();

  const [confirmedDraft, setConfirmedDraft] = useState<ConstraintSetArtifact | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.conversations(), retry: false });

  useEffect(() => {
    const items = conversations.data?.items ?? [];
    if (!conversationId && items.length > 0) {
      const first = items[0];
      api.history(first.id).then((h) => {
        const msgs = h.messages.map((m: any) => ({ seq: m.seq, role: m.role, kind: m.kind, content: m.content ?? '', payload: m.payload }));
        setConversation(first.id, msgs);
        const lastSet = [...h.messages].reverse().find((m: any) => m.kind === 'constraint_set');
        if (lastSet?.payload) useChatStore.setState({ artifact: lastSet.payload, clarifications: lastSet.payload.clarifications_needed ?? [] });
        if (first.status === 'active') chat.resume();
      }).catch(() => {});
    }
  }, [conversations.data]);

  const onConfirm = (draft: ConstraintSetArtifact) => {
    previewArtifact(draft);
    setConfirmedDraft(draft);
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.kind === 'text');

  return (
    <aside className="guidy-noise flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-site-line bg-site-bg shadow-sm" aria-label="AI 对话排程">
      <div className="flex items-center justify-between border-b border-site-line px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-site-ink"><Sparkles className="h-4 w-4 text-site-brand" /> AI 对话排程</h2>
        <div className="flex items-center gap-1">
          {me.data && <span className="tabular text-[10px] text-site-ink-soft">今日剩余 {me.data.quotas.chat_remaining}</span>}
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="新建对话" onClick={() => { chat.newConversation(); setConfirmedDraft(null); }}>
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite">
        {isSample && (
          <div className="animate-guidy-fade-up rounded-lg border border-[var(--site-dawn-line)]/30 bg-[var(--site-dawn-soft)] p-3">
            <p className="text-sm font-semibold text-site-ink">示例计划 · 在职考研冲刺</p>
            <p className="mt-1 text-xs leading-relaxed text-site-ink-soft">右侧是预置示例。直接告诉我你的安排，Guidy 会提取约束并生成计划；首次保存后示例自动清空。</p>
            <Button variant="outline" size="sm" className="mt-2 h-7 text-xs" onClick={() => { clearSample(); toast('已清空示例，开始你的计划吧'); }}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> 清空，从头开始
            </Button>
          </div>
        )}
        {messages.length === 0 && !isSample && (
          <p className="px-1 text-xs leading-relaxed text-site-ink-soft">你好，我是 Guidy。说说你的任务与时间约束，例如「每天学 6 小时，周三晚兼职，数学英语别连着学」。</p>
        )}
        {messages.map((m) => (
          <MessageBubble key={`${m.seq}-${m.role}-${m.kind}`} message={m} streaming={streaming && m.seq === lastAssistant?.seq} />
        ))}
        {clarifications.length > 0 && (
          <div className="rounded-lg border border-site-line bg-site-surface p-3">
            <p className="text-xs font-semibold text-site-ink">还需要确认：</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-site-ink-soft">
              {clarifications.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          </div>
        )}
        {artifact && clarifications.length === 0 && !confirmedDraft && (
          <ConstraintConfirmCard artifact={artifact} onConfirm={onConfirm} onCancel={() => useChatStore.setState({ artifact: null })} />
        )}
        {confirmedDraft && preview && (
          <div className="rounded-lg border border-[var(--site-dawn-line)]/40 bg-site-surface p-3">
            <p className="text-xs text-site-ink">预览已生成（右侧日历 ghost 块）。确认保存到云端？</p>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { discardPreview(); setConfirmedDraft(null); }}>放弃</Button>
              <Button size="sm" className="dawn-gradient text-white" disabled={isPending} onClick={() => commit(confirmedDraft)}>
                {isPending ? '保存中…' : '确认保存'}
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p className="rounded-lg border border-site-danger/30 bg-site-danger/5 px-3 py-2 text-xs text-site-danger">
            {error.message}{error.diagnosticId ? `（诊断 ID：${error.diagnosticId}）` : ''}
          </p>
        )}
        {connection === 'connecting' && <p className="px-1 text-[11px] text-site-ink-soft">正在连接…</p>}
      </div>

      <ChatInput streaming={streaming} onSend={(t) => { setConfirmedDraft(null); chat.send(t); }} onInterrupt={() => chat.interrupt()} />
    </aside>
  );
}
```

- [ ] **Step 7: 修改 `store/useUiStore.ts`**

将 `export type MobileTab = 'overview' | 'calendar';` 改为：

```ts
export type MobileTab = 'chat' | 'calendar';
```

将初始 `mobileTab: 'calendar',` 改为 `mobileTab: 'chat',`。

- [ ] **Step 8: 修改 `src/main.tsx` 包裹 QueryClientProvider**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import App from "./App";
import "./globals.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 9: 修改 `src/App.tsx`**

把 import `OverviewPanel` 替换为 `ChatPanel`：

```tsx
import { ChatPanel } from '@/components/chat/ChatPanel';
```

左栏容器与移动 Tab 判断改为 chat：

```tsx
          <div className={cn('min-h-0 w-full lg:block lg:w-[38%] lg:shrink-0', mobileTab === 'chat' ? 'block' : 'hidden')}>
            <ChatPanel />
          </div>
```

底部导航数组改为：

```tsx
          {([
            { key: 'chat', label: '对话', icon: MessageSquare },
            { key: 'calendar', label: '日历', icon: CalendarDays },
          ] as const).map((t) => (
```

并把 lucide import 中的 `LayoutList` 替换为 `MessageSquare`（`import { CalendarDays, MessageSquare } from 'lucide-react';`）。日历容器宽度改为 `lg:w-[62%]`（与对话 38% 对应，spec §2）。

- [ ] **Step 10: 修改 `components/workbench/TopBar.tsx` 增加抽屉入口**

在 lucide import 加入 `ListChecks, ShieldCheck`；在「社区模板」按钮之前插入：

```tsx
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="约束条件" onClick={() => openDrawer('constraints')}>
          <ShieldCheck className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="任务定义" onClick={() => openDrawer('tasks')}>
          <ListChecks className="h-4 w-4" />
        </Button>
```

- [ ] **Step 11: 删除 `components/workbench/OverviewPanel.tsx`**

Run: `git rm components/workbench/OverviewPanel.tsx`
（其示例横幅迁入 ChatPanel，约束/任务/统计经 TopBar 抽屉入口访问；确认无其它 import：`npx tsc --noEmit` 会暴露残留引用。）

- [ ] **Step 12: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全绿。

- [ ] **Step 13: 浏览器人工核验（本地 fixture loop）**

Run: `npm run dev:function`（Task 9 credential-free fake）+ `npm run dev`，浏览器打开 http://127.0.0.1:5173/：
- 左栏对话暖纸底、右栏日历冷白，桌面约 38%/62%；移动端底部 Tab「对话/日历」切换，默认对话。
- 输入「每天学 6 小时，周三晚兼职」发送 → accepted → delta 流式（dawn 竖条呼吸）→ artifact 确认卡。
- 确认卡逐条编辑/删除/补充、mutex 软↔硬、Esc 取消、焦点陷阱；[确认并生成] → 日历 ghost 预览 + 预览确认条。
- [确认保存] → 乐观应用 → 成功 toast、示例清空、服务端 plan 为唯一源；失败回滚保留预览（可断网模拟）。
- 中断按钮取消生成；新建对话清空且旧流不污染；刷新页面只 GET history/events 恢复（Network 面板确认零 POST send）。
- 配额耗尽显示「额度用完」；409 busy 显示等待提示。

- [ ] **Step 14: Commit**

```bash
git add lib/chatController.ts lib/useChat.ts components/chat/ChatPanel.tsx src/App.tsx src/main.tsx store/useUiStore.ts components/workbench/TopBar.tsx lib/__tests__/chatController.test.ts
git commit -m "feat(m2): chat controller, panel, app shell integration with query provider"
```

---

### Task 16: 私有部署与验收（C1–C7 / A2/A3/A9 / T3 / T4）

**Files:**
- Modify: `docs/TODO.md`（记录 M2 部署与验收结果）
- 无新增源码；本任务产出**部署证据 + 验收报告**（三者分离：本地 fixture / 站点发布 / 真实 AI 执行）。

**Interfaces:**
- Consumes: Task 10 已应用的迁移与迁移后 `schemaRef`；Task 9 `functions/index.ts`（config `cloudApiOrigin:'https://api.qoder.com.cn'`、`appScope:'guidy-site-01a1e421-fb71-7745-9db4-db763e874017'`、`modelId:''` 懒解析）；Sites MCP 工具；browser-use MCP
- Produces: 私有站点发布版本 + 验收结论（M2 保持 **private**，public 属 M4）

> 已知资源（复用，勿新建）：projectId `01a1e421-fb6e-756e-a7c8-44fd5a28b23f`；siteId `01a1e421-fb71-7745-9db4-db763e874017`；host `guidy-oxg3oo3dpdz.qoder.zone`（private，未发布）；backendRef `sr_NmX_Fpu_D2EYCYC2nbp3ZeQg3TF1xa8A-jkbpV7cYCHMVhh98AKD6hc16_ONkAE93lnKb5f3Of-5YUMNKbhv1aJLENls4OljV1HAnjoBKT01jk47oE8jKHAyZRU`。所有 Sites 写操作用稳定 UUID `requestId`，未知结果保留 refs/params 先诊断再决定，不盲目重试。`QODER_PAT` 平台托管，**不进** `secretNames`、不下发、不入日志。

- [ ] **Step 1: 部署前本地门禁（T2 首周已验证，此处复跑）**

Run:
```bash
npx deno check functions/app.ts
npx tsc --noEmit
npx vitest run
npm run build
```
Expected: Deno 类型 gate 通过（npm:zod/date-fns 兼容，T2）；tsc 通过；vitest 全绿（M1 33 + M2 新增，含 R6–R9/R13/R16–R18）；`dist/index.html` 产出。任一失败先修复再继续（systematic-debugging）。

- [ ] **Step 2: 确认迁移已应用并取新 schemaRef**

通过 Sites MCP `get_database_schema`（siteId 上述）读取当前结构，确认 Task 10 的 10 张表（plans/task_defs/constraints/blocks/conversations/messages/dispatch_intents/commit_log/quotas/cloud_bindings）存在。保存返回的**新** `schemaRef`（迁移后必须重读，勿用空库旧 ref）。若表缺失，回到 Task 10 完成 create→审阅→用户确认→apply→get_operation→verify。

- [ ] **Step 3: prepare_site（完整草稿，新 actionId）**

调用 `prepare_site`：
- `projectId`: `01a1e421-fb6e-756e-a7c8-44fd5a28b23f`
- `siteId`: `01a1e421-fb71-7745-9db4-db763e874017`
- `webDirectory`: `dist`，`spa`: true
- `functionDirectory`: `functions`
- `databaseAccess`: `read_write`，`schemaRef`: Step 2 新 ref
- `secretNames`: 省略 `QODER_PAT`（平台托管）；M2 无其它应用 Secret
- `requestId`: 新稳定 UUID
保存返回的 actionId/refs。准备草稿**不发布**。

- [ ] **Step 4: publish_site 到 private（需用户授权）**

向用户说明：将把完整草稿发布到**私有**站点（owner 可访问，公众不可），M2 不公开。获确认后调用 `publish_site`（siteId、Step 3 actionId、`access_mode: 'private'`、稳定 requestId、confirm）。轮询 `get_operation` 至 terminal；accepted/queued/running 不算完成。

- [ ] **Step 5: 验证站点与后端状态**

`get_site`（include `["backend","functions"]`）确认：`lifecycle: 'active'`、`access_mode: 'private'`、`hasPublishedContent: true`、backend capabilities 含 `qoder`（就绪）、functions 部署成功。`get_site(include:["secrets"])` 空列表**不**代表 QODER_PAT 缺失（平台托管故意省略）。若 `qoder` 缺失或 `sites_qoder_pat_forbidden`，按 initialization.md 报告阻断，不推荐依赖 AI 的发布，不自动新建 PAT。

- [ ] **Step 6: owner 身份浏览器实测（真实 AI，非 fixture）**

用 browser-use MCP 打开 `https://guidy-oxg3oo3dpdz.qoder.zone`（owner 登录态）。逐项核验并截图存证：
- **T3 匿名身份**：`GET /functions/v1/app/api/me` 返回 `visitor_id`（`requireUser(ctx)` 匿名路径生效）；私有数据按访客隔离。失败 → 触发 Plan B（自建匿名 token + 恢复码升 P0），记录阻断。
- **A2 对话采集**：输入 PRD §2.2 需求（每天 6 小时学习、周三晚兼职、数学英语不连续）→ SSE 增量输出；≤3 轮产出约束确认卡，含每日上限/忙碌窗口/互斥/偏好四类。
- **C1 send 首事件**：Network 面板见 202 + 首事件 `accepted`（含 request_id/conversation_id/seq）。
- **C2 流式增量**：delta 有序拼接 = 最终 text；artifact 仅在 Schema 校验通过后出现。
- **A3 确认生成**：确认卡 → 日历 7 天计划；硬约束零违反；生成有流式/骨架状态；commit 服务端重算 violations 非空拒绝落库。
- **C3 断线重连**：生成中断网/重连 → `GET /chat/events?cursor` 回放无重复无丢失，续流至 done。
- **C4 刷新页面**：刷新后只 GET history/events，**零 POST send**（Network 面板验证）。
- **A9 恢复**：刷新/重开浏览器自动恢复计划与对话，不重发消息。
- **C5 interrupt**：点中断 → status=interrupted，上游流关闭，可继续新消息。
- **C6 新建对话旧流未结束**：旧 reader 取消，旧 seq 不写入新视图。
- **C7 artifact 校验失败**：构造非法 artifact（本地 fixture 已覆盖重试≤2）；部署侧若触发，日志可见重试，仍失败 → error `artifact_invalid` + 上下文保留。
- **SEC3 凭据**：检查错误响应/页面/source map/日志接口，PAT 零暴露。

- [ ] **Step 7: T4 流式延迟实测**

重复 A2 发送 5 次，记录首 token 到达时间（accepted→首个 delta）。计算 P95，目标 <3s。逐条转发不缓冲全文（Task 7 投影已保证）。超标则排查上游/投影缓冲，记录数据。

- [ ] **Step 8: 验收分离报告 + 记录 TODO**

在 `docs/TODO.md` 追加 M2 验收小节，明确三段证据：
1. **本地 fixture**：`npm run dev:function` credential-free fake 的路由/投影/协调 vitest 结论（R6–R9/R13/R16–R18）。
2. **站点发布**：private 发布版本、lifecycle/access_mode/backend qoder 就绪截图。
3. **真实 AI 执行**：owner 浏览器 C1–C7/A2/A3/A9/T3/T4 实测结论 + 截图。
强调：ready backend / HTTP 200 **不算** AI 验收；必须有真实 QCA 完成响应。M2 保持 private，C3（公开访问）属 M4。

- [ ] **Step 9: Commit**

```bash
git add docs/TODO.md
git commit -m "docs(m2): record private deployment and acceptance evidence"
```

---

## 验收覆盖映射（self-review 用）

| Spec 要求 | 实现任务 |
| --- | --- |
| §1 application(deps) DI + fake | Task 1/2/9 |
| §1 引擎服务端 commit 重算 | Task 3/8 |
| §1 系统指令固定服务端 | Task 3 prompt.ts |
| §2 布局 38/62 + 移动 Tab | Task 15 |
| §2 MessageBubble/sanitize | Task 12 |
| §2 StreamingCursor reduced-motion | Task 12 |
| §2 ConstraintConfirmCard 焦点陷阱/mutex | Task 13 |
| §2 ChatInput ≤2000 / 聚焦 / 中断 | Task 12 |
| §2 TanStack 乐观回滚 + 示例共存 | Task 14/15 |
| §3 send 顺序/配额/并发/幂等 | Task 2/4/7 |
| §3 流投影白名单 + artifact 重试 | Task 5/7 |
| §3 游标重连/刷新零 POST | Task 7/11/15 |
| §3 interrupt/新建对话 | Task 7/15 |
| §3 commit 幂等/无解/hash/version | Task 8/14 |
| §4 10 表迁移（受限 SQL） | Task 10 |
| §5 错误包络/码表/前端映射 | Task 1/11/15 |
| §5 XSS/PAT 边界 | Task 12/9/16 |
| §6 vitest fake 注入 | Task 1–8 |
| §6 Deno gate（T2） | Task 1/9/16 |
| §6 部署 private 实测 | Task 16 |
| §7 C1–C7/A2/A3/A9/T3/T4 | Task 16 |