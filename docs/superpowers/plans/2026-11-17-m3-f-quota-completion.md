# M3-F 配额限流补全 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（subagent 不可用时按内联 fallback 逐任务执行，标准不变）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐计划数量配额（20/访客）、对话配额 ≤10 轮警告与耗尽禁用输入、UIUX 标准文案。

**Spec:** docs/superpowers/specs/2026-11-17-m3-f-quota-completion-design.md（3c53e63，用户已确认）。

**Architecture:** 零迁移/零新端点。commit 新建分支 COUNT 守卫（软上限）；前端复用 me 查询 + ChatInput 既有 disabled prop。

**Tech Stack:** Deno Edge Function + npm:zod；React 19 + TanStack Query；vitest NODE 环境（组件豁免单测）。

## Global Constraints

- 分支 Guidy-Qoder 直接工作；不 merge/push/publish（发布授权已撤回）。
- 零 PAT/身份/引擎/依赖/迁移改动；不动 chat 60/日 CAS、并发 ≤1、recovery 10/日。
- 每任务门禁：`npx vitest run` + `npm run check:function` + `npm run build`（>500kB chunk 警告为既有非错误）。
- 基线：258 tests / 32 files。T1 后预期 262 / 32（新增 4 用例入既有 plans.test.ts）。
- `.Guidy.qoder.site` 平台再生成，排除于一切提交。
- ledger：`.superpowers/sdd/2026-11-17-m3-f-quota-completion/progress.md`（身份行+预检表+逐任务记录+裁决）。

## Execution Notes

- 内联 fallback：subagent 仅 context7:docs-researcher 可用；TDD/门禁/自审标准不变，独立 subagent 评审不执行，终审内联。
- 浏览器实测经验（E ledger）：图标按钮按 aria-label 定位；程序化 click 比 uid 稳；wait_for text 必须数组；TaskStop 后须 netstat 验证子进程死亡，残留 taskkill；5173 origin 可能有旧 localStorage，先 clear+reload。
- /me stub 后触发 refetch：ChatPanel 常挂载（CSS 隐藏，不卸载），用 `window.dispatchEvent(new Event('focus'))`（react-query refetchOnWindowFocus 默认开）；若不生效试 `new Event('online')`；仍不生效则记录裁决改用脚本化 send 消耗配额（慢路径）。

## Task 1: 后端 — 计划数配额 + 文案 + 4 测试（TDD）

**Files:**
- Modify: `functions/__tests__/plans.test.ts`（追加 describe）
- Modify: `shared/constants.ts:52`
- Modify: `functions/routes/plans.ts:8,87-89`
- Modify: `functions/errors.ts:16,27`

**Interfaces:**
- Consumes: `seedPlan(d, input?)`（plans.test.ts:82 既有，函数声明提升可用）、`hashFor`、`deps/ctx`、`createMemoryDb`。
- Produces: `QUOTAS.plansPerVisitor: 20`；错误码 `plan_quota_exceeded` 429 details `{limit:20}`；MESSAGES 两条文案。

- [ ] **Step 1: RED — 追加测试**

在 `functions/__tests__/plans.test.ts` 文件末尾追加：

```ts
describe('plan quota (F)', () => {
  it('第 20 个新建成功；第 21 个 429 plan_quota_exceeded，零新增', async () => {
    const d = deps();
    for (let i = 0; i < 19; i++) await seedPlan(d);
    const result_hash = await hashFor(baseInput);
    const ok = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'q20', plan_id: null, input: baseInput, result_hash, engine_version: 1 }));
    expect(ok.status).toBe(200);
    expect(d.db.tables.plans).toHaveLength(20);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'q21', plan_id: null, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('plan_quota_exceeded');
    expect(body.error.details.limit).toBe(20);
    expect(d.db.tables.plans).toHaveLength(20);
  });
  it('满 20 仍可更新既有计划，version+1', async () => {
    const d = deps();
    let first: any;
    for (let i = 0; i < 20; i++) { const p = await seedPlan(d); if (i === 0) first = p; }
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'qu1', plan_id: first.id, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(2);
    expect(d.db.tables.plans).toHaveLength(20);
  });
  it('删除 1 个后新建恢复成功（额度释放）', async () => {
    const d = deps();
    let first: any;
    for (let i = 0; i < 20; i++) { const p = await seedPlan(d); if (i === 0) first = p; }
    expect((await application(d)(ctx('DELETE', `/api/plans/${first.id}`))).status).toBe(200);
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'qr1', plan_id: null, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    expect(d.db.tables.plans).toHaveLength(20);
  });
  it('MESSAGES：quota_exceeded 为 UIUX 标准句；plan_quota_exceeded 含 20', async () => {
    const { MESSAGES } = await import('../errors');
    expect(MESSAGES.quota_exceeded).toBe('今天的对话额度用完了，明天再来继续规划。');
    expect(MESSAGES.plan_quota_exceeded).toContain('20');
  });
});
```

- [ ] **Step 2: 跑测试确认 RED**

`npx vitest run functions/__tests__/plans.test.ts` → 前 3 个新用例失败（第 21 个返回 200 而非 429）、文案用例失败（旧句/缺码）。既有用例全绿。

- [ ] **Step 3: GREEN — 三处实现**

`shared/constants.ts:52` 整行替换：

```ts
export const QUOTAS = { chatTurnsPerDay: 60, publishesPerDay: 3, recoveryAttemptsPerDay: 10, plansPerVisitor: 20 };
```

`functions/routes/plans.ts:8` 改为：

```ts
import { ENGINE_VERSION, LIMITS, QUOTAS } from '../../shared/constants.ts';
```

`functions/routes/plans.ts` commitPlan 新建分支（`} else {` 与 `plan = rows(...insert...)` 之间）插入守卫：

```ts
  } else {
    const count = rows(await deps.db.from('plans').select('id').eq('owner_visitor_id', visitor)).length;
    if (count >= QUOTAS.plansPerVisitor) fail('plan_quota_exceeded', 429, { limit: QUOTAS.plansPerVisitor });
    plan = rows(await deps.db.from('plans').insert({ owner_visitor_id: visitor, title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, status: 'active', version: 1 }).select('*'))[0];
  }
```

`functions/errors.ts`：`quota_exceeded` 行替换 + `recovery_rate_limited` 行后追加：

```ts
  quota_exceeded: '今天的对话额度用完了，明天再来继续规划。',
  plan_quota_exceeded: '计划数量已达上限（20 个），删除旧计划后再新建',
```

- [ ] **Step 4: 门禁**

`npx vitest run`（262/262，32 files）+ `npm run check:function` + `npm run build`。

- [ ] **Step 5: 提交**

```bash
git add functions/__tests__/plans.test.ts shared/constants.ts functions/routes/plans.ts functions/errors.ts
git commit -m "feat(m3-f): plan count quota (20/visitor) + UIUX quota copy"
```

## Task 2: 前端 — ChatPanel 警告/禁用 + 浏览器实测

**Files:**
- Modify: `components/chat/ChatPanel.tsx`（me 查询后派生 + ChatInput 前渲染 + disabled 接线）

**Interfaces:**
- Consumes: `me.data.quotas.chat_remaining`（既有 useQuery ['me'] retry:false）；`ChatInput disabled?: boolean`（既有 prop，submit/textarea/发送按钮均已判 disabled）。
- Produces: 无新接口；纯渲染逻辑。

- [ ] **Step 1: 实现**

ChatPanel.tsx `const me = useQuery(...)` 与 `const conversations = useQuery(...)` 之间不动；在 return 前（`const lastAssistant = ...` 之后）加：

```ts
  const chatRemaining = me.data?.quotas.chat_remaining;
  const quotaExhausted = chatRemaining === 0;
```

底部 `<ChatInput ... />` 替换为：

```tsx
      {chatRemaining !== undefined && chatRemaining <= 10 && (
        <p className="px-3 pb-1 text-[11px] text-site-ink-soft">
          {quotaExhausted ? '今天的对话额度用完了，明天再来继续规划。' : `今日对话额度还剩 ${chatRemaining} 轮`}
        </p>
      )}
      <ChatInput streaming={streaming} disabled={quotaExhausted} onSend={(t) => { setConfirmedDraft(null); setConfirmedPatch(null); chat.send(t); }} onInterrupt={() => chat.interrupt()} />
```

顶栏「今日剩余 N」保留不动。ChatInput 不改。

- [ ] **Step 2: 门禁**

`npx vitest run`（262/262）+ `npm run check:function` + `npm run build`。

- [ ] **Step 3: 浏览器实测**

启动 `npm run dev:function` + `npm run dev`（background；读输出确认实际端口；先 netstat 清残留）。导航后 `localStorage.clear()` + reload 保证干净态。

1. **计划配额 UI 链路**：页内 fetch 脚本创建 20 个计划：
   ```js
   const input = { title: '配额测试', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai',
     task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }], constraints: [] };
   const statuses = [];
   for (let i = 1; i <= 21; i++) {
     const r = await fetch('/functions/v1/app/api/plans/commit', { method: 'POST', headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ preview_id: 'quota-test-' + i, plan_id: null, input, result_hash: 'x', engine_version: 1 }) });
     statuses.push(r.status);
   }
   ```
   断言前 20 个 200、第 21 个 429。随后真实 UI 对话流（发送「帮我安排每天数学真题90分钟」→ 确认并生成 → 确认保存）→ toast 含「计划数量已达上限」+ 诊断 ID。
2. **≤10 警告**：stub fetch 仅拦 `/api/me`：
   ```js
   const origFetch = window.fetch;
   window.fetch = (u, o) => String(u).includes('/api/me')
     ? Promise.resolve(Response.json({ visitor_id: 'v', quotas: { chat_remaining: 5, publish_remaining: 3 }, has_recovery_code: false }))
     : origFetch(u, o);
   window.dispatchEvent(new Event('focus'));
   ```
   等 500ms → 输入框上方出现「今日对话额度还剩 5 轮」。
3. **耗尽禁用**：同 stub 改 chat_remaining: 0 → focus → 文案「今天的对话额度用完了，明天再来继续规划。」+ textarea disabled + 发送按钮 disabled。恢复 `window.fetch = origFetch` → focus → 警告消失、输入恢复。
4. **控制台**：无错误（vite debug / React DevTools info 除外）。

若 focus 不触发 refetch：试 `new Event('online')`；仍不行记录裁决改慢路径（脚本 send 消耗配额）。

停掉两个 dev 进程（netstat 验证子进程死亡，残留 taskkill）。

- [ ] **Step 4: 提交**

```bash
git add components/chat/ChatPanel.tsx
git commit -m "feat(web): chat quota low-remaining warning and exhausted input disable"
```

## Self-Review（计划完成后内联执行）

- 对照 spec §0–§7 逐项：20 上限/仅新建分支/幂等回放不受影响/文案原句/me 失败不禁用/零迁移零 PAT。
- diff 范围仅 5 文件（constants/plans/errors/plans.test/ChatPanel）。
- 门禁数字与预期一致（262/32）。
- 浏览器 4 项证据齐全。
- finishing-a-development-branch：测试→环境→3 选项菜单（预期保留现状，仍须用户选择）→记忆更新（F COMPLETE，M3 全齐）。