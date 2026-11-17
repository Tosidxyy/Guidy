# M3-C 多计划前端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: subagents are disabled in this environment (only context7:docs-researcher registered) → execute inline with identical TDD/gates/self-review criteria; independent subagent review is not performed.

**Goal:** 让用户管理多个计划（列表/切换/新建/删除/重命名），每个计划拥有独立 AI 对话上下文，复用 M2/A/B 闭环。

**Architecture:** 服务端 `app.plans` 为计划注册表（复用 `GET /plans`+`GET /plans/:id`），localStorage 仅缓存活动工作态；新增 `DELETE /api/plans/:id`（显式幂等清理子表）+ commit 对话绑定；前端新增纯函数 helper、DI 编排 core、react-query 钩子、共享 chat 控制器单例与「计划」抽屉。

**Tech Stack:** React + Zustand + @tanstack/react-query + vitest（node 环境，无 jsdom）+ Deno Edge Function + npm:zod@3.25.76 + sonner + lucide-react + Sheet/AlertDialog（radix）。

**Spec:** docs/superpowers/specs/2026-11-16-m3-c-multi-plan-frontend-design.md

## Global Constraints

- 安全/平台：`QODER_PAT` 仅经 Function 内 `Deno.env.get('QODER_PAT')` 读取，绝不进浏览器/日志/`secretNames`/普通 Secret 写入。Deno 仅作 npm devDependency；本地门禁针对平台无关的 `functions/app.ts`。未经新的点名授权不发布（当前发布已撤回）；M2 保持 private（public=M4）。
- 删除归属：`DELETE` 经 `getOwnedPlan`→404/403，绝不删他人计划。commit 对话绑定仅当对话归属本人且 `plan_id IS NULL` 才置位，best-effort，不使 commit 失败，绝不重绑。
- **fake-db 陷阱**：`.eq(col, null)` 会抛 `database_invalid_operation`（PostgREST 同样非法）→ 判空一律在 JS 里 `=== null`，或用 `.is(col, null)`；本计划全部用 JS 判空，不用 `.eq(null)`。`.delete()` 无 filter 会删全表 → 删除必须带 `.eq`。fake-db 不强制 FK，清理逻辑靠断言表为空验证；生产 FK 为 NO ACTION，故清理顺序必须 blocks→task_defs→constraints→commit_log→conversations(NULL)→plans。
- 无通用 DB 事务：删除用依赖顺序幂等语句，中途失败可重跑补齐。无需 schema 迁移（`plans.deleted_at` 存在但 C 不使用）。
- 范围护栏：引擎/undo/redo/preview/commit/patch 语义与 version 并发语义不变；`ENGINE_VERSION=1` 不变；不加计划数量配额（服务端 list ≤50，配额留 F）；跨设备/身份留 D；导出留 E。
- 测试环境：vitest node 环境（无 jsdom）→ 纯逻辑+后端路由+DI core 单测；钩子/组件经 `tsc`/build + 浏览器实测。每任务 TDD：RED→看失败→GREEN→提交。
- 门禁：`npx vitest run` 全绿 + `npm run check:function`（`npx deno check --config dev/deno.check.json functions/app.ts`）+ `npm run build`（tsc --noEmit + vite + function-package）。既有 >500kB chunk 警告非错误。
- UI 文案中文，沿用站点语气。`.Guidy.qoder.site` 平台再生，排除于所有提交，绝不手写。不以 mock 冒充真实 AI/持久化做验收。
- 前端 import 用 `@/` 别名；functions 内用相对 `../` 路径；functions 测试用 `../app`、`../../dev/fake-db`、`../../dev/fake-qca`。

## File Structure

**新增**
- `lib/planConversation.ts` — 纯函数 `conversationForPlan`（按 plan_id 选对话）。
- `lib/planManagerCore.ts` — DI 编排 core `createPlanManager(deps)`（switch/new/delete/restoreConversation），node 可测（仿 createChatController）。
- `lib/chatRuntime.ts` — 模块单例 `chatController`（一个 stream + controller）。
- `lib/usePlanManager.ts` — 薄钩子：`['plans']`/`['conversations']` 查询 +  wiring core + pending。
- `components/workbench/PlansDrawer.tsx` — 计划抽屉 UI（Sheet + AlertDialog + Dialog）。
- 测试：`lib/__tests__/planConversation.test.ts`、`lib/__tests__/planManagerCore.test.ts`、`lib/__tests__/chatRuntime.test.ts`。

**修改**
- `functions/routes/plans.ts` — `deletePlan` handler + `CommitSchema.conversation_id` + commitPlan 绑定。
- `functions/app.ts` — 注册 `DELETE /api/plans/:id`。
- `functions/__tests__/plans.test.ts` — deletePlan + 绑定测试。
- `store/usePlanStore.ts` — `dirty` 标记。
- `store/__tests__/planStore.test.ts` — dirty 测试。
- `store/useUiStore.ts` — `DrawerKind` 加 `'plans'`。
- `lib/api.ts` — `deletePlan`。
- `lib/commitInput.ts` + `lib/__tests__/commitInput.test.ts` — `conversation_id` 透传。
- `lib/useChat.ts` — 返回单例。
- `lib/useCommitPlan.ts` / `lib/useApplyPatch.ts` — conversation_id + invalidate `['plans']`。
- `components/chat/ChatPanel.tsx` — 恢复按 plan 选对话。
- `components/workbench/TopBar.tsx` — 计划入口图标。
- `src/App.tsx` — 渲染 `<PlansDrawer />`。

**任务顺序**：T1 后端删除 → T2 后端绑定 → T3 conversationForPlan → T4 dirty → T5 api/commitInput 契约 → T6 chatRuntime 单例 → T7 编排 core → T8 钩子 wiring → T9 ChatPanel 恢复 → T10 抽屉 UI。每任务结束门禁全绿 + 提交。

---

### Task 1: 后端 DELETE /api/plans/:id（显式幂等清理）

**Files:**
- Modify: `functions/routes/plans.ts`（加 `deletePlan`，置于 `getPlan` 后）
- Modify: `functions/app.ts:7,21`（import + 注册 DELETE 路由）
- Test: `functions/__tests__/plans.test.ts`（加 seedPlan helper + describe 'deletePlan'）

**Interfaces:**
- Consumes: `getOwnedPlan(db, visitor, id)`（plans.ts 已导出，404/403）；`requireVisitor(deps, ctx)`；`rows`；Db `.delete().eq()`/`.update().eq()`。
- Produces: `deletePlan(ctx: RouteCtx, deps: Deps, params: string[]): Promise<Response>` → `200 { ok: true }`；路由 `DELETE /api/plans/:id`。

- [ ] **Step 1: 写失败测试**

在 `functions/__tests__/plans.test.ts` 末尾追加（并在文件顶部 import 区确认已有 `solve`/`resultHash`/`application`/`createMemoryDb`/`createFakeQca`/`ctx`/`deps`/`baseInput`/`hashFor`；新增 seedPlan helper）：

```ts
async function seedPlan(d: Deps, input: any = baseInput) {
  const out = solve({ engine_version: 1, ...input, pinned_blocks: [] });
  const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: crypto.randomUUID(), plan_id: null, input, result_hash: await resultHash(out.blocks), engine_version: 1 }));
  return (await res.json()).plan;
}
const inputWithConstraint = { ...baseInput, constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }] };

describe('deletePlan', () => {
  it('本人删除 → 200，plan 及子表清空，对话解绑但保留', async () => {
    const d = deps();
    const plan = await seedPlan(d, inputWithConstraint);
    await d.db.from('conversations').insert({ owner_visitor_id: 'v', title: 'c', plan_id: plan.id, qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' });
    const res = await application(d)(ctx('DELETE', `/api/plans/${plan.id}`));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(d.db.tables.plans).toHaveLength(0);
    expect(d.db.tables.task_defs).toHaveLength(0);
    expect(d.db.tables.constraints).toHaveLength(0);
    expect(d.db.tables.blocks).toHaveLength(0);
    expect(d.db.tables.commit_log).toHaveLength(0);
    expect(d.db.tables.conversations).toHaveLength(1);
    expect(d.db.tables.conversations[0].plan_id).toBeNull();
  });
  it('跨访客 → 403，不删任何表', async () => {
    const d = deps();
    const plan = await seedPlan(d, inputWithConstraint);
    const res = await application(d)(ctx('DELETE', `/api/plans/${plan.id}`, undefined, { id: 'other' }));
    expect(res.status).toBe(403);
    expect(d.db.tables.plans).toHaveLength(1);
    expect(d.db.tables.blocks.length).toBeGreaterThan(0);
  });
  it('不存在 → 404', async () => {
    const res = await application(deps())(ctx('DELETE', `/api/plans/${crypto.randomUUID()}`));
    expect(res.status).toBe(404);
  });
  it('重复删除幂等 → 404，不破坏他计划', async () => {
    const d = deps();
    const a = await seedPlan(d, inputWithConstraint);
    const b = await seedPlan(d, { ...inputWithConstraint, title: '另一个' });
    const app = application(d);
    expect((await app(ctx('DELETE', `/api/plans/${a.id}`))).status).toBe(200);
    expect((await app(ctx('DELETE', `/api/plans/${a.id}`))).status).toBe(404);
    expect(d.db.tables.plans).toHaveLength(1);
    expect(d.db.tables.plans[0].id).toBe(b.id);
    expect(d.db.tables.blocks.every((x: any) => x.plan_id === b.id)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试看失败**

Run: `npx vitest run functions/__tests__/plans.test.ts -t deletePlan`
Expected: FAIL — DELETE 路由未注册（404 not_found 路由级或 handler 缺失），本人删除用例断言 200 失败。

- [ ] **Step 3: 实现 deletePlan + 注册路由**

在 `functions/routes/plans.ts` 的 `getPlan` 函数后追加：

```ts
export async function deletePlan(ctx: RouteCtx, deps: Deps, params: string[]): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const plan = await getOwnedPlan(deps.db, visitor, params[0]);
  await deps.db.from('blocks').delete().eq('plan_id', plan.id);
  await deps.db.from('task_defs').delete().eq('plan_id', plan.id);
  await deps.db.from('constraints').delete().eq('plan_id', plan.id);
  await deps.db.from('commit_log').delete().eq('plan_id', plan.id);
  await deps.db.from('conversations').update({ plan_id: null }).eq('plan_id', plan.id).eq('owner_visitor_id', visitor);
  await deps.db.from('plans').delete().eq('id', plan.id).eq('owner_visitor_id', visitor);
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
```

在 `functions/app.ts`：import 行改为 `import { listPlans, getPlan, commitPlan, deletePlan } from './routes/plans.ts';`；在 `GET /api/plans/([^/]+)` 路由后追加：

```ts
    { method: 'DELETE', pattern: /^\/api\/plans\/([^/]+)$/, handler: deletePlan },
```

- [ ] **Step 4: 运行测试看通过**

Run: `npx vitest run functions/__tests__/plans.test.ts`
Expected: PASS（含既有 commitPlan/getPlan 用例）。

- [ ] **Step 5: 门禁 + 提交**

```bash
npx vitest run && npm run check:function && npm run build
git add functions/routes/plans.ts functions/app.ts functions/__tests__/plans.test.ts
git commit -m "feat(m3-c): add owner-scoped DELETE /plans/:id with explicit idempotent child cleanup"
```

---

### Task 2: 后端 commit 对话绑定（conversation_id）

**Files:**
- Modify: `functions/routes/plans.ts`（CommitSchema + commitPlan 解构 + 绑定）
- Test: `functions/__tests__/plans.test.ts`（加 describe 'commitPlan conversation binding'）

**Interfaces:**
- Consumes: T1 的 seedPlan helper；`rows`；Db conversations `.select().eq().limit()`/`.update().eq()`。
- Produces: `CommitSchema.conversation_id?: string|null`；commitPlan 在新建/覆盖后 best-effort 绑定 `conversations.plan_id`。

- [ ] **Step 1: 写失败测试**

在 `functions/__tests__/plans.test.ts` 末尾追加：

```ts
describe('commitPlan conversation binding', () => {
  it('新建 + 本人 null-plan 对话 → 绑定到新 plan.id', async () => {
    const d = deps();
    const ins = await d.db.from('conversations').insert({ owner_visitor_id: 'v', title: 'c', plan_id: null, qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' });
    const convId = ins.data[0].id;
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'b1', plan_id: null, conversation_id: convId, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    const planId = (await res.json()).plan.id;
    expect(d.db.tables.conversations[0].plan_id).toBe(planId);
  });
  it('对话非本人 → 忽略绑定，commit 仍成功', async () => {
    const d = deps();
    const ins = await d.db.from('conversations').insert({ owner_visitor_id: 'other', title: 'c', plan_id: null, qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' });
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'b2', plan_id: null, conversation_id: ins.data[0].id, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    expect(d.db.tables.conversations[0].plan_id).toBeNull();
  });
  it('对话已绑定 → 不重绑', async () => {
    const d = deps();
    const ins = await d.db.from('conversations').insert({ owner_visitor_id: 'v', title: 'c', plan_id: 'existing-plan', qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' });
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'b3', plan_id: null, conversation_id: ins.data[0].id, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    expect(d.db.tables.conversations[0].plan_id).toBe('existing-plan');
  });
  it('无 conversation_id → 行为不变（向后兼容）', async () => {
    const d = deps();
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'b4', plan_id: null, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    expect(d.db.tables.plans).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试看失败**

Run: `npx vitest run functions/__tests__/plans.test.ts -t "conversation binding"`
Expected: FAIL — 绑定用例 conversations[0].plan_id 仍为 null（commitPlan 未处理 conversation_id）。

- [ ] **Step 3: 实现绑定**

在 `functions/routes/plans.ts` 的 `CommitSchema` 对象内（`engine_version` 行后）加：

```ts
  conversation_id: z.string().min(1).nullable().optional(),
```

`commitPlan` 解构行改为：

```ts
  const { preview_id, plan_id, input, result_hash, engine_version, conversation_id } = parsed.data;
```

在 `commitPlan` 的 `await deps.db.from('commit_log').insertIfAbsent(...)` 行之后、最终 `const blocks = ...` 之前插入：

```ts
  if (conversation_id) {
    const conv = rows(await deps.db.from('conversations').select('*').eq('id', conversation_id).eq('owner_visitor_id', visitor).limit(1))[0];
    if (conv && conv.plan_id === null) {
      await deps.db.from('conversations').update({ plan_id: plan.id }).eq('id', conv.id).eq('owner_visitor_id', visitor);
    }
  }
```

- [ ] **Step 4: 运行测试看通过**

Run: `npx vitest run functions/__tests__/plans.test.ts`
Expected: PASS（全部）。

- [ ] **Step 5: 门禁 + 提交**

```bash
npx vitest run && npm run check:function && npm run build
git add functions/routes/plans.ts functions/__tests__/plans.test.ts
git commit -m "feat(m3-c): bind draft conversation to plan on commit via optional conversation_id"
```

---

### Task 3: 纯函数 conversationForPlan

**Files:**
- Create: `lib/planConversation.ts`
- Test: `lib/__tests__/planConversation.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `interface ConversationLike { id: string; plan_id: string | null; status?: string }`；`conversationForPlan(items: ConversationLike[], planId: string | null): ConversationLike | null`（items 已按 updated_at desc 排序，取首个严格相等匹配，null 匹配 null）。

- [ ] **Step 1: 写失败测试**

Create `lib/__tests__/planConversation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { conversationForPlan } from '@/lib/planConversation';

const items = [{ id: 'a', plan_id: 'p1' }, { id: 'b', plan_id: 'p2' }, { id: 'c', plan_id: null }];
describe('conversationForPlan', () => {
  it('取首个 plan_id 匹配项', () => { expect(conversationForPlan(items, 'p2')?.id).toBe('b'); });
  it('null 匹配草稿桶', () => { expect(conversationForPlan(items, null)?.id).toBe('c'); });
  it('无匹配 → null', () => { expect(conversationForPlan(items, 'p9')).toBeNull(); });
  it('空列表 → null', () => { expect(conversationForPlan([], 'p1')).toBeNull(); });
  it('多个匹配取传入顺序首个', () => {
    const dup = [{ id: 'x', plan_id: 'p1' }, { id: 'y', plan_id: 'p1' }];
    expect(conversationForPlan(dup, 'p1')?.id).toBe('x');
  });
});
```

- [ ] **Step 2: 运行测试看失败**

Run: `npx vitest run lib/__tests__/planConversation.test.ts`
Expected: FAIL — 无法解析 `@/lib/planConversation`（模块不存在）。

- [ ] **Step 3: 实现**

Create `lib/planConversation.ts`:

```ts
export interface ConversationLike { id: string; plan_id: string | null; status?: string }

// items 须已按 updated_at desc 排序（listConversations 保证）；取首个 plan_id 严格相等匹配。
export function conversationForPlan(items: ConversationLike[], planId: string | null): ConversationLike | null {
  return items.find((c) => c.plan_id === planId) ?? null;
}
```

- [ ] **Step 4: 运行测试看通过**

Run: `npx vitest run lib/__tests__/planConversation.test.ts`
Expected: PASS（5 用例）。

- [ ] **Step 5: 门禁 + 提交**

```bash
npx vitest run && npm run check:function && npm run build
git add lib/planConversation.ts lib/__tests__/planConversation.test.ts
git commit -m "feat(m3-c): add conversationForPlan pure helper"
```

---

### Task 4: usePlanStore.dirty 标记

**Files:**
- Modify: `store/usePlanStore.ts`（interface + 初始 + commit/undo/redo/importState/replaceStateKeepUndo/resetAll）
- Test: `store/__tests__/planStore.test.ts`（加 describe 'dirty 标记'）

**Interfaces:**
- Consumes: 现有 store 方法。
- Produces: `PlanStore.dirty: boolean`（commit/undo/redo→true；importState/replaceStateKeepUndo/resetAll/init→false）。

- [ ] **Step 1: 写失败测试**

在 `store/__tests__/planStore.test.ts` 末尾追加（复用文件内已有的 `seeded`）：

```ts
describe('dirty 标记', () => {
  it('importState 后 dirty=false', () => {
    usePlanStore.getState().importState(seeded);
    expect(usePlanStore.getState().dirty).toBe(false);
  });
  it('commit（renamePlan）后 dirty=true', () => {
    usePlanStore.getState().importState(seeded);
    usePlanStore.getState().renamePlan('新名');
    expect(usePlanStore.getState().dirty).toBe(true);
  });
  it('undo/redo 后 dirty=true', () => {
    usePlanStore.getState().importState(seeded);
    usePlanStore.getState().renamePlan('x');
    usePlanStore.getState().undo();
    expect(usePlanStore.getState().dirty).toBe(true);
    usePlanStore.getState().redo();
    expect(usePlanStore.getState().dirty).toBe(true);
  });
  it('replaceStateKeepUndo 后 dirty=false', () => {
    usePlanStore.getState().importState(seeded);
    usePlanStore.getState().renamePlan('x');
    usePlanStore.getState().replaceStateKeepUndo(seeded);
    expect(usePlanStore.getState().dirty).toBe(false);
  });
  it('resetAll 后 dirty=false', () => {
    usePlanStore.getState().renamePlan('x');
    usePlanStore.getState().resetAll();
    expect(usePlanStore.getState().dirty).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试看失败**

Run: `npx vitest run store/__tests__/planStore.test.ts -t "dirty"`
Expected: FAIL — `dirty` 为 undefined（store 未定义该字段）。

- [ ] **Step 3: 实现 dirty**

在 `store/usePlanStore.ts`：
- `interface PlanStore` 内（`lastCompromises` 行后）加 `dirty: boolean;`
- create 返回对象初始（`lastCompromises: [],` 行后）加 `dirty: false,`
- `commit` 的 `set({ state: draft, undoStack: next, redoStack: [] });` 改为 `set({ state: draft, undoStack: next, redoStack: [], dirty: true });`
- `undo` 的 set 对象加 `dirty: true,`（在 `preview: null,` 后）
- `redo` 的 set 对象加 `dirty: true,`（在 `preview: null,` 后）
- `importState` 的 `set({ state, undoStack: [], redoStack: [], preview: null });` 改为 `set({ state, undoStack: [], redoStack: [], preview: null, dirty: false });`
- `replaceStateKeepUndo` 的 `set({ state: next, undoStack: stack, preview: null });` 改为 `set({ state: next, undoStack: stack, preview: null, dirty: false });`
- `resetAll` 的 set 对象加 `dirty: false,`（在 `lastCompromises: []` 后）

- [ ] **Step 4: 运行测试看通过**

Run: `npx vitest run store/__tests__/planStore.test.ts`
Expected: PASS（含既有 previewPatch/replaceStateKeepUndo 用例）。

- [ ] **Step 5: 门禁 + 提交**

```bash
npx vitest run && npm run check:function && npm run build
git add store/usePlanStore.ts store/__tests__/planStore.test.ts
git commit -m "feat(m3-c): track dirty flag in plan store to gate plan switching"
```

---

### Task 5: api.deletePlan + commitInput.conversation_id 契约

**Files:**
- Modify: `lib/api.ts`（api 对象加 deletePlan）
- Modify: `lib/commitInput.ts`（CommitBody + buildCommitInput）
- Test: `lib/__tests__/commitInput.test.ts`（加 2 用例）

**Interfaces:**
- Consumes: `requestJson`（api.ts）。
- Produces: `api.deletePlan(id: string): Promise<{ ok: boolean }>`；`CommitBody.conversation_id?: string | null`；`buildCommitInput(args & { conversationId?: string | null })` 输出 `conversation_id: conversationId ?? null`。

- [ ] **Step 1: 写失败测试**

在 `lib/__tests__/commitInput.test.ts` 的 `describe('buildCommitInput', ...)` 内追加：

```ts
  it('conversation_id 透传', async () => {
    const { output } = solveArtifact(draft, plan, []);
    const body = await buildCommitInput({ draft, plan, blocks: output.blocks, previewId: 'pv-2', planId: null, conversationId: 'conv-1' });
    expect(body.conversation_id).toBe('conv-1');
  });
  it('未提供 conversationId → conversation_id 为 null', async () => {
    const { output } = solveArtifact(draft, plan, []);
    const body = await buildCommitInput({ draft, plan, blocks: output.blocks, previewId: 'pv-3', planId: null });
    expect(body.conversation_id).toBeNull();
  });
```

- [ ] **Step 2: 运行测试看失败**

Run: `npx vitest run lib/__tests__/commitInput.test.ts`
Expected: FAIL — `body.conversation_id` 为 undefined。

- [ ] **Step 3: 实现契约**

`lib/commitInput.ts`：
- `CommitBody` 接口加 `conversation_id?: string | null;`（在 `engine_version: number;` 后）
- `buildCommitInput` args 类型加 `conversationId?: string | null;`（在 `planId: string | null;` 后）
- 解构 `const { draft, plan, blocks, previewId, planId } = args;` 改为 `const { draft, plan, blocks, previewId, planId, conversationId } = args;`
- return 对象加 `conversation_id: conversationId ?? null,`（在 `engine_version: ENGINE_VERSION,` 后）

`lib/api.ts`：在 api 对象 `applyPatch` 行后加：

```ts
  deletePlan: (id: string) => requestJson<{ ok: boolean }>(`/plans/${encodeURIComponent(id)}`, { method: 'DELETE' }),
```

- [ ] **Step 4: 运行测试看通过**

Run: `npx vitest run lib/__tests__/commitInput.test.ts`
Expected: PASS（3 用例）。`api.deletePlan` 由 build 类型校验（无 fetch 单测）。

- [ ] **Step 5: 门禁 + 提交**

```bash
npx vitest run && npm run check:function && npm run build
git add lib/api.ts lib/commitInput.ts lib/__tests__/commitInput.test.ts
git commit -m "feat(m3-c): add api.deletePlan and conversation_id passthrough in commit input"
```

---

### Task 6: chatRuntime 单例 + useChat 重构

**Files:**
- Create: `lib/chatRuntime.ts`
- Modify: `lib/useChat.ts`（返回单例）
- Test: `lib/__tests__/chatRuntime.test.ts`

**Interfaces:**
- Consumes: `createChatStream`（lib/sse）、`createChatController`（lib/chatController）、`useChatStore`、`usePlanStore`。
- Produces: `chatController`（模块单例，含 send/resume/interrupt/newConversation）；`useChat()` 返回同一单例。

- [ ] **Step 1: 写失败测试**

Create `lib/__tests__/chatRuntime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chatController } from '@/lib/chatRuntime';
import { useChatStore } from '@/store/useChatStore';

describe('chatRuntime 单例', () => {
  it('newConversation 重置 chatStore', () => {
    useChatStore.setState({ conversationId: 'old', restoreDone: true, messages: [{ seq: 1, role: 'user', kind: 'text', content: 'hi' }] });
    chatController.newConversation();
    const s = useChatStore.getState();
    expect(s.conversationId).toBeNull();
    expect(s.messages).toHaveLength(0);
    expect(s.restoreDone).toBe(true);
  });
  it('多次导入为同一实例', async () => {
    const a = await import('@/lib/chatRuntime');
    const b = await import('@/lib/chatRuntime');
    expect(a.chatController).toBe(b.chatController);
  });
});
```

- [ ] **Step 2: 运行测试看失败**

Run: `npx vitest run lib/__tests__/chatRuntime.test.ts`
Expected: FAIL — 无法解析 `@/lib/chatRuntime`（模块不存在）。

- [ ] **Step 3: 实现单例 + 重构 useChat**

Create `lib/chatRuntime.ts`:

```ts
import { createChatStream } from '@/lib/sse';
import { createChatController } from '@/lib/chatController';
import { useChatStore } from '@/store/useChatStore';
import { usePlanStore } from '@/store/usePlanStore';

// 应用级单例：ChatPanel 与 usePlanManager 共用一条 SSE stream，避免编排时产生第二条流。
export const chatController = createChatController({
  store: useChatStore,
  stream: createChatStream(),
  getPlanId: () => usePlanStore.getState().state.plan.id,
});
```

Replace `lib/useChat.ts` 全部内容为：

```ts
import { chatController } from '@/lib/chatRuntime';

export function useChat() {
  return chatController;
}
```

- [ ] **Step 4: 运行测试看通过**

Run: `npx vitest run lib/__tests__/chatRuntime.test.ts`
Expected: PASS（2 用例）。

- [ ] **Step 5: 门禁 + 提交**

```bash
npx vitest run && npm run check:function && npm run build
git add lib/chatRuntime.ts lib/useChat.ts lib/__tests__/chatRuntime.test.ts
git commit -m "refactor(m3-c): lift chat controller to a shared module singleton"
```

---

### Task 7: DI 编排 core createPlanManager

**Files:**
- Create: `lib/planManagerCore.ts`
- Test: `lib/__tests__/planManagerCore.test.ts`

**Interfaces:**
- Consumes: T3 `conversationForPlan`/`ConversationLike`；`cursorAfterMessages`（store/useChatStore）；`buildEmptyPlan`（lib/seed）；`PlanState`（shared/types）。
- Produces:
  ```ts
  interface PlanManagerDeps {
    fetchPlan(id: string): Promise<PlanState>;
    deletePlan(id: string): Promise<{ ok: boolean }>;
    fetchHistory(id: string): Promise<{ conversation: any; messages: any[] }>;
    getPlanState(): PlanState;
    importState(s: PlanState): void;
    getConversations(): ConversationLike[];
    setConversation(id: string | null, messages?: any[]): void;
    setChatState(patch: Record<string, unknown>): void;
    newConversation(): void;
    resume(): void;
    isStreaming(): boolean;
    invalidatePlans(): void;
    listPlans(): Promise<{ id: string }[]>;
  }
  createPlanManager(deps: PlanManagerDeps): {
    switchPlan(id: string): Promise<void>;
    newPlan(): void;
    deletePlan(id: string): Promise<void>;
    restoreConversation(planId: string | null): Promise<void>;
  }
  ```

- [ ] **Step 1: 写失败测试**

Create `lib/__tests__/planManagerCore.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createPlanManager } from '@/lib/planManagerCore';
import type { PlanState } from '@/shared/types';

const serverPlan: PlanState = { plan: { id: 'p2', title: 't', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' }, task_defs: [], constraints: [], blocks: [] };
function fakeDeps(over: Record<string, unknown> = {}) {
  return {
    fetchPlan: vi.fn(async () => serverPlan),
    deletePlan: vi.fn(async () => ({ ok: true })),
    fetchHistory: vi.fn(async () => ({ conversation: {}, messages: [{ seq: 1, role: 'assistant', kind: 'text', content: 'hi' }] })),
    getPlanState: () => ({ plan: { id: 'p1' } } as PlanState),
    importState: vi.fn(),
    getConversations: () => [{ id: 'c2', plan_id: 'p2', status: 'active' }],
    setConversation: vi.fn(),
    setChatState: vi.fn(),
    newConversation: vi.fn(),
    resume: vi.fn(),
    isStreaming: () => false,
    invalidatePlans: vi.fn(),
    listPlans: vi.fn(async () => [{ id: 'p3' }]),
    ...over,
  };
}
describe('createPlanManager', () => {
  it('switchPlan 流式中 → no-op', async () => {
    const d = fakeDeps({ isStreaming: () => true });
    await createPlanManager(d).switchPlan('p2');
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });
  it('switchPlan 正常 → fetchPlan + importState + 恢复对话 + resume', async () => {
    const d = fakeDeps();
    await createPlanManager(d).switchPlan('p2');
    expect(d.fetchPlan).toHaveBeenCalledWith('p2');
    expect(d.importState).toHaveBeenCalledWith(serverPlan);
    expect(d.setConversation).toHaveBeenCalledWith('c2', expect.any(Array));
    expect(d.resume).toHaveBeenCalled();
  });
  it('switchPlan 同 id → 不 fetchPlan', async () => {
    const d = fakeDeps();
    await createPlanManager(d).switchPlan('p1');
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });
  it('newPlan → importState 空计划 + newConversation', () => {
    const d = fakeDeps();
    createPlanManager(d).newPlan();
    expect(d.importState).toHaveBeenCalled();
    expect(d.newConversation).toHaveBeenCalled();
  });
  it('deletePlan 非当前 → 删除 + invalidate，不切换', async () => {
    const d = fakeDeps();
    await createPlanManager(d).deletePlan('p9');
    expect(d.deletePlan).toHaveBeenCalledWith('p9');
    expect(d.invalidatePlans).toHaveBeenCalled();
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });
  it('deletePlan 当前且有剩余 → 切到首个剩余', async () => {
    const d = fakeDeps();
    await createPlanManager(d).deletePlan('p1');
    expect(d.fetchPlan).toHaveBeenCalledWith('p3');
  });
  it('deletePlan 当前且无剩余 → newPlan', async () => {
    const d = fakeDeps({ listPlans: vi.fn(async () => []) });
    await createPlanManager(d).deletePlan('p1');
    expect(d.newConversation).toHaveBeenCalled();
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });
  it('restoreConversation 无匹配 → newConversation', async () => {
    const d = fakeDeps({ getConversations: () => [] });
    await createPlanManager(d).restoreConversation('p2');
    expect(d.newConversation).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试看失败**

Run: `npx vitest run lib/__tests__/planManagerCore.test.ts`
Expected: FAIL — 无法解析 `@/lib/planManagerCore`。

- [ ] **Step 3: 实现 core**

Create `lib/planManagerCore.ts`:

```ts
import { conversationForPlan, type ConversationLike } from '@/lib/planConversation';
import { cursorAfterMessages } from '@/store/useChatStore';
import { buildEmptyPlan } from '@/lib/seed';
import type { PlanState } from '@/shared/types';

export interface PlanManagerDeps {
  fetchPlan(id: string): Promise<PlanState>;
  deletePlan(id: string): Promise<{ ok: boolean }>;
  fetchHistory(id: string): Promise<{ conversation: any; messages: any[] }>;
  getPlanState(): PlanState;
  importState(s: PlanState): void;
  getConversations(): ConversationLike[];
  setConversation(id: string | null, messages?: any[]): void;
  setChatState(patch: Record<string, unknown>): void;
  newConversation(): void;
  resume(): void;
  isStreaming(): boolean;
  invalidatePlans(): void;
  listPlans(): Promise<{ id: string }[]>;
}

export function createPlanManager(deps: PlanManagerDeps) {
  async function restoreConversation(planId: string | null) {
    const conv = conversationForPlan(deps.getConversations(), planId);
    if (!conv) { deps.newConversation(); return; }
    const h = await deps.fetchHistory(conv.id);
    const msgs = h.messages.map((m: any) => ({ seq: m.seq, role: m.role, kind: m.kind, content: m.content ?? '', payload: m.payload }));
    deps.setConversation(conv.id, msgs);
    deps.setChatState({ cursor: cursorAfterMessages(h.messages) });
    const lastArt = [...h.messages].reverse().find((m: any) => m.kind === 'constraint_set' || m.kind === 'patch');
    if (lastArt?.payload) {
      if (lastArt.kind === 'constraint_set') deps.setChatState({ artifact: lastArt.payload, clarifications: lastArt.payload.clarifications_needed ?? [], patch: null });
      else deps.setChatState({ patch: lastArt.payload, artifact: null, clarifications: [] });
    }
    if (conv.status === 'active') deps.resume();
  }
  async function switchPlan(id: string) {
    if (deps.isStreaming()) return;
    if (deps.getPlanState().plan.id === id) { await restoreConversation(id); return; }
    const serverPlan = await deps.fetchPlan(id);
    deps.importState(serverPlan);
    await restoreConversation(id);
  }
  function newPlan() {
    if (deps.isStreaming()) return;
    deps.importState(buildEmptyPlan());
    deps.newConversation();
  }
  async function deletePlan(id: string) {
    if (deps.isStreaming()) return;
    await deps.deletePlan(id);
    deps.invalidatePlans();
    if (deps.getPlanState().plan.id === id) {
      const remaining = (await deps.listPlans()).filter((p) => p.id !== id);
      if (remaining.length) await switchPlan(remaining[0].id);
      else newPlan();
    }
  }
  return { switchPlan, newPlan, deletePlan, restoreConversation };
}
```

- [ ] **Step 4: 运行测试看通过**

Run: `npx vitest run lib/__tests__/planManagerCore.test.ts`
Expected: PASS（8 用例）。

- [ ] **Step 5: 门禁 + 提交**

```bash
npx vitest run && npm run check:function && npm run build
git add lib/planManagerCore.ts lib/__tests__/planManagerCore.test.ts
git commit -m "feat(m3-c): add DI plan manager core for switch/new/delete orchestration"
```

---

### Task 8: usePlanManager 钩子 + commit/patch invalidate 接线

**Files:**
- Create: `lib/usePlanManager.ts`
- Modify: `lib/useCommitPlan.ts`（conversation_id + invalidate）
- Modify: `lib/useApplyPatch.ts`（invalidate）

**Interfaces:**
- Consumes: T5 `api.deletePlan`/`buildCommitInput(conversationId)`；T6 `chatController`；T7 `createPlanManager`；`usePlanStore`/`useChatStore`；`@tanstack/react-query`。
- Produces: `usePlanManager(): { plans: PlanListItem[]; isLoading; isError; refetch; switchPlan; newPlan; deletePlan; isPending }`，`PlanListItem = { id; title; status; horizon_start; horizon_days; timezone; version; updated_at }`。

> 本任务为 react-query 钩子 wiring，node 环境不可单测（无 jsdom）；可判定逻辑已在 T3/T4/T7 单测覆盖。验证靠 `npm run build`（tsc）+ 浏览器实测（T10 后）。

- [ ] **Step 1: 实现 usePlanManager**

Create `lib/usePlanManager.ts`:

```ts
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { usePlanStore } from '@/store/usePlanStore';
import { useChatStore } from '@/store/useChatStore';
import { chatController } from '@/lib/chatRuntime';
import { createPlanManager } from '@/lib/planManagerCore';

export interface PlanListItem { id: string; title: string; status: string; horizon_start: string; horizon_days: number; timezone: string; version: number; updated_at: string }

export function usePlanManager() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['plans'], queryFn: () => api.plans(), retry: false });
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.conversations(), retry: false });
  const [pending, setPending] = useState(false);
  const manager = createPlanManager({
    fetchPlan: (id) => api.plan(id),
    deletePlan: (id) => api.deletePlan(id),
    fetchHistory: (id) => api.history(id),
    getPlanState: () => usePlanStore.getState().state,
    importState: (s) => usePlanStore.getState().importState(s),
    getConversations: () => conversations.data?.items ?? [],
    setConversation: (id, msgs) => useChatStore.getState().setConversation(id, msgs),
    setChatState: (patch) => useChatStore.setState(patch),
    newConversation: () => chatController.newConversation(),
    resume: () => chatController.resume(),
    isStreaming: () => useChatStore.getState().streaming,
    invalidatePlans: () => { qc.invalidateQueries({ queryKey: ['plans'] }); },
    listPlans: async () => (await api.plans()).items,
  });
  const run = async (fn: () => void | Promise<void>) => { setPending(true); try { await fn(); } finally { setPending(false); } };
  return {
    plans: (query.data?.items ?? []) as PlanListItem[],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    switchPlan: (id: string) => run(() => manager.switchPlan(id)),
    newPlan: () => run(() => manager.newPlan()),
    deletePlan: (id: string) => run(() => manager.deletePlan(id)),
    isPending: pending,
  };
}
```

- [ ] **Step 2: useCommitPlan 接线**

`lib/useCommitPlan.ts`：
- 顶部加 `import { useQueryClient } from '@tanstack/react-query';`（与现有 useMutation import 合并）与 `import { useChatStore } from '@/store/useChatStore';`
- 钩子体首行加 `const qc = useQueryClient();`
- `buildCommitInput({...})` 调用加 `conversationId: useChatStore.getState().conversationId,`（在 `planId: store.state.plan.id ?? null,` 后）
- `onSuccess` 末尾（toast 前）加 `qc.invalidateQueries({ queryKey: ['plans'] });`

- [ ] **Step 3: useApplyPatch 接线**

`lib/useApplyPatch.ts`：
- 顶部加 `import { useQueryClient } from '@tanstack/react-query';`（合并进现有 import）
- 钩子体首行加 `const qc = useQueryClient();`
- `onSuccess` 末尾（toast 前）加 `qc.invalidateQueries({ queryKey: ['plans'] });`

- [ ] **Step 4: 类型/构建验证**

Run: `npm run build`
Expected: exit 0（tsc --noEmit 通过；既有 chunk 警告非错误）。`npx vitest run` 仍全绿（无新增单测，既有不受影响）。

- [ ] **Step 5: 门禁 + 提交**

```bash
npx vitest run && npm run check:function && npm run build
git add lib/usePlanManager.ts lib/useCommitPlan.ts lib/useApplyPatch.ts
git commit -m "feat(m3-c): wire usePlanManager hook and invalidate plans on commit/patch"
```

---

### Task 9: ChatPanel 按计划恢复对话

**Files:**
- Modify: `components/chat/ChatPanel.tsx:44-59`（恢复 effect）

**Interfaces:**
- Consumes: T3 `conversationForPlan`；`usePlanStore.state.plan.id`。
- Produces: 初始自动恢复按当前计划选对话（取代 items[0]）。

> 组件，node 不可单测；选对话逻辑已由 T3 覆盖。验证靠 build + 浏览器实测。

- [ ] **Step 1: 修改恢复 effect**

`components/chat/ChatPanel.tsx`：
- 顶部加 `import { conversationForPlan } from '@/lib/planConversation';`
- 在 `const preview = usePlanStore((s) => s.preview);` 前加 `const planId = usePlanStore((s) => s.state.plan.id);`
- 恢复 effect 内 `const first = items[0];` 改为：
  ```ts
    const first = conversationForPlan(items, planId);
    if (!first) return;
  ```
- effect 依赖数组 `[conversations.data, conversationId, restoreDone]` 改为 `[conversations.data, conversationId, restoreDone, planId]`

- [ ] **Step 2: 类型/构建验证**

Run: `npm run build`
Expected: exit 0。`npx vitest run` 全绿。

- [ ] **Step 3: 门禁 + 提交**

```bash
npx vitest run && npm run check:function && npm run build
git add components/chat/ChatPanel.tsx
git commit -m "feat(m3-c): restore chat conversation for the active plan"
```

---

### Task 10: 「计划」抽屉 UI + 入口 + 渲染

**Files:**
- Modify: `store/useUiStore.ts:3`（DrawerKind 加 'plans'）
- Create: `components/workbench/PlansDrawer.tsx`
- Modify: `components/workbench/TopBar.tsx`（FolderOpen 入口）
- Modify: `src/App.tsx`（渲染 PlansDrawer）

**Interfaces:**
- Consumes: T4 `dirty`/`renamePlan`；T8 `usePlanManager`；`useChatStore.streaming`；`useUiStore.drawer/closeDrawer/openDrawer`；Sheet/AlertDialog/Dialog/Button/Input/Badge（components/ui）。
- Produces: `PlansDrawer` 组件；`DrawerKind 'plans'`；TopBar 计划入口。

> UI 组件，node 不可单测；验证靠 build（tsc）+ 浏览器实测。**重命名仅对当前计划卡片可用**（renamePlan 作用于活动态；非当前计划需先切换——符合 spec 已知限制②，不加服务端 rename 端点）。

- [ ] **Step 1: DrawerKind 加 'plans'**

`store/useUiStore.ts:3` 改为：

```ts
export type DrawerKind = 'constraints' | 'block' | 'settings' | 'tasks' | 'plans' | null;
```

- [ ] **Step 2: 实现 PlansDrawer**

Create `components/workbench/PlansDrawer.tsx`:

```tsx
import { useState } from 'react';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { usePlanStore } from '@/store/usePlanStore';
import { useChatStore } from '@/store/useChatStore';
import { useUiStore } from '@/store/useUiStore';
import { usePlanManager } from '@/lib/usePlanManager';
import { cn } from '@/lib/utils';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

type Confirm = { kind: 'switch' | 'new' | 'delete'; id?: string; title?: string } | null;

export function PlansDrawer() {
  const open = useUiStore((s) => s.drawer === 'plans');
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  const currentId = usePlanStore((s) => s.state.plan.id);
  const dirty = usePlanStore((s) => s.dirty);
  const renamePlan = usePlanStore((s) => s.renamePlan);
  const streaming = useChatStore((s) => s.streaming);
  const { plans, isLoading, isError, refetch, switchPlan, newPlan, deletePlan, isPending } = usePlanManager();

  const [confirm, setConfirm] = useState<Confirm>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const busy = streaming || isPending;

  const requestSwitch = (id: string) => {
    if (busy || id === currentId) return;
    if (dirty) setConfirm({ kind: 'switch', id });
    else { void switchPlan(id); closeDrawer(); }
  };
  const requestNew = () => {
    if (busy) return;
    if (dirty) setConfirm({ kind: 'new' });
    else { newPlan(); closeDrawer(); }
  };
  const requestDelete = (id: string, title: string) => { if (!busy) setConfirm({ kind: 'delete', id, title }); };
  const runConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === 'switch' && confirm.id) { void switchPlan(confirm.id); closeDrawer(); }
    else if (confirm.kind === 'new') { newPlan(); closeDrawer(); }
    else if (confirm.kind === 'delete' && confirm.id) { void deletePlan(confirm.id); }
    setConfirm(null);
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) closeDrawer(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-b border-site-line px-5 py-4">
          <SheetTitle className="font-display flex items-center gap-2"><FolderOpen className="h-4 w-4 text-site-brand" /> 我的计划</SheetTitle>
          <SheetDescription>切换、新建或删除计划。每个计划有独立的 AI 对话。</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-3 px-5 py-4">
          <Button className="w-full" onClick={requestNew} disabled={busy}><Plus className="mr-1.5 h-4 w-4" /> 新建计划</Button>
          {streaming && <p className="text-[11px] text-site-ink-soft">对话进行中，请先中断再管理计划。</p>}
          {isLoading && <p className="text-xs text-site-ink-soft">加载中…</p>}
          {isError && (
            <div className="flex items-center justify-between rounded-lg border border-site-line px-3 py-2 text-xs text-site-ink-soft">
              列表加载失败 <Button variant="outline" size="sm" onClick={() => refetch()}>重试</Button>
            </div>
          )}
          {currentId === null && (
            <div className="rounded-lg border border-site-brand/40 bg-site-brand/5 px-3 py-2 text-xs text-site-ink">未保存草稿 <Badge variant="secondary" className="ml-1">当前</Badge></div>
          )}
          {plans.map((p) => (
            <div key={p.id} className={cn('rounded-lg border px-3 py-2', p.id === currentId ? 'border-site-brand/50 bg-site-brand/5' : 'border-site-line')}>
              <div className="flex items-center justify-between gap-2">
                <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium text-site-ink hover:text-site-brand disabled:opacity-50" onClick={() => requestSwitch(p.id)} disabled={busy || p.id === currentId}>
                  {p.title}
                </button>
                {p.id === currentId && <Badge variant="secondary">当前</Badge>}
              </div>
              <p className="tabular mt-0.5 text-[11px] text-site-ink-soft">{p.horizon_start} · {p.horizon_days} 天 · v{p.version}</p>
              <div className="mt-1.5 flex justify-end gap-1">
                {p.id === currentId && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => { setDraft(p.title); setRenaming(true); }}>重命名</Button>
                )}
                <Button variant="ghost" size="icon" className="h-7 w-7 text-site-danger hover:text-site-danger" aria-label={`删除「${p.title}」`} onClick={() => requestDelete(p.id, p.title)} disabled={busy}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
          {!isLoading && !isError && plans.length === 0 && currentId !== null && (
            <p className="text-xs text-site-ink-soft">还没有已保存的计划。新建一个，或在对话中生成后保存。</p>
          )}
        </div>

        <AlertDialog open={!!confirm} onOpenChange={(v) => { if (!v) setConfirm(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display">{confirm?.kind === 'delete' ? `删除计划「${confirm.title}」？` : '放弃未保存的更改？'}</AlertDialogTitle>
              <AlertDialogDescription>{confirm?.kind === 'delete' ? '此操作不可恢复，关联对话将解绑。' : '当前计划有未保存的更改，切换将丢弃。继续？'}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={runConfirm}>确认</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={renaming} onOpenChange={setRenaming}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader><DialogTitle className="font-display">重命名计划</DialogTitle></DialogHeader>
            <Input autoFocus value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { renamePlan(draft.trim()); setRenaming(false); } }} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setRenaming(false)}>取消</Button>
              <Button disabled={!draft.trim()} onClick={() => { renamePlan(draft.trim()); setRenaming(false); }}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 3: TopBar 入口**

`components/workbench/TopBar.tsx`：
- lucide import 加 `FolderOpen`
- 在「约束条件」按钮（`aria-label="约束条件"`）前加：
  ```tsx
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="计划管理" onClick={() => openDrawer('plans')}>
          <FolderOpen className="h-4 w-4" />
        </Button>
  ```

- [ ] **Step 4: App 渲染**

`src/App.tsx`：
- import 区加 `import { PlansDrawer } from '@/components/workbench/PlansDrawer';`
- 在 `<SettingsDrawer />` 后加 `<PlansDrawer />`

- [ ] **Step 5: 类型/构建验证**

Run: `npm run build`
Expected: exit 0（tsc 通过）。`npx vitest run` 全绿。

- [ ] **Step 6: 全量门禁 + 提交**

```bash
npx vitest run && npm run check:function && npm run build
git add store/useUiStore.ts components/workbench/PlansDrawer.tsx components/workbench/TopBar.tsx src/App.tsx
git commit -m "feat(m3-c): add plans drawer with switch/new/delete/rename and TopBar entry"
```

- [ ] **Step 7: 浏览器实测（需发布授权后 live；本地可 `npm run dev` 验证 UI 接线）**

黄金路径：新建草稿→对话生成→commit（对话绑定）→列表出现→新建第二个→切换（活动态+对话各自恢复）→patch 迭代→删除当前（兜底切换/新建）→删除非当前（列表刷新）。边界：脏切换确认、streaming 守卫、删当前且列表空→新草稿、每计划对话独立恢复、当前卡重命名。不以 mock 冒充真实 AI/持久化。live 真实 AI 验收需新的点名发布授权（当前发布已撤回）。

---

## Self-Review

**1. Spec coverage：**
- Q1 服务端列表+本地活动缓存 → T8（['plans'] 查询）+ T7（switch=fetchPlan+importState）+ 既有 storage（活动态缓存不变）。✓
- Q2 对话跟随计划 → T3（conversationForPlan）+ T7（restoreConversation）+ T9（ChatPanel 初始恢复）+ T2（commit 绑定）。✓
- Q3 硬删除+DELETE 端点 → T1。✓ FK 修正（显式幂等清理）→ T1 实现+测试。✓
- Q4 计划抽屉 → T10。✓
- dirty 门控 → T4 + T10（requestSwitch/requestNew 确认）。✓
- chatRuntime 单例 → T6。✓
- api.deletePlan / commitInput.conversation_id → T5。✓
- useCommitPlan/useApplyPatch invalidate → T8。✓
- streaming 守卫 → T7（core isStreaming）+ T10（busy 禁用）。✓
- 已知限制（list ≤50 / rename 本地 / null 草稿）→ T10 rename 仅当前卡 + spec 注明。✓
- 测试策略（后端/store/纯函数/commitInput/DI core 单测；钩子组件 build+browser）→ T1/T2/T3/T4/T5/T7 单测，T8/T9/T10 build+browser。✓

**2. Placeholder scan：** 无 TBD/TODO；每步含完整代码/命令/预期。`{title}` 为运行时 UI 模板（非 spec 缺口）。✓

**3. Type consistency：**
- `conversationForPlan(items, planId)` / `ConversationLike{id,plan_id,status?}` 在 T3 定义，T7/T9 一致使用。✓
- `createPlanManager(deps)` 返回 {switchPlan,newPlan,deletePlan,restoreConversation}，T7 定义、T8 wiring 一致。✓
- `PlanManagerDeps` 各方法签名 T7 定义与 T8 提供的实参类型一致（fetchPlan→api.plan 返回 any 兼容 PlanState；getConversations→items 含 plan_id/status）。✓
- `api.deletePlan(id):Promise<{ok:boolean}>` T5 定义、T7/T8 使用一致。✓
- `CommitBody.conversation_id` / `buildCommitInput(conversationId)` T5 定义、T8 useCommitPlan 传参一致。✓
- `chatController` T6 定义、T8 使用一致。✓
- `dirty` T4 定义、T10 读取一致。✓
- `DrawerKind 'plans'` T10 定义、TopBar openDrawer('plans')/PlansDrawer drawer==='plans' 一致。✓
- 后端 `deletePlan(ctx,deps,params)` 签名仿 getPlan，app.ts 注册一致。✓

无缺口。