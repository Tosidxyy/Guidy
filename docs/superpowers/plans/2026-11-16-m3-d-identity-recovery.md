# M3-D 恢复码/身份 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 匿名访客凭一次性恢复码跨设备/清缓存后认领旧身份数据（归属转移），并提供「删除我的全部数据」与隐私声明页脚。

**Architecture:** 平台匿名身份链路零改动。新表 `app.recovery_codes` 只存 SHA-256(规范化码)；claim 在当前设备平台身份下经两步条件更新认领锁 + `overwritten_at` 阶段标记，先覆盖删除当前设备数据、再把旧 visitor 名下数据的 owner 列 UPDATE 为当前 visitor。delete-all 复用同一 `deleteVisitorData` 级联。前端 SettingsDrawer 新增「身份与数据」节 + App 底部隐私页脚。

**Tech Stack:** Deno Edge Function（npm devDependency）+ npm:zod@3.25.76 + vitest（node 环境，无 jsdom）+ dev/fake-db 内存库 + React 19 / Zustand / @tanstack/react-query / sonner / lucide-react / shadcn-style UI。

**Spec:** `docs/superpowers/specs/2026-11-16-m3-d-identity-recovery-design.md`（绑定权威；计划与 spec 冲突时以 spec 为准，执行者两者都读）

## Global Constraints

以下逐字来自 spec「全局约束（每个任务隐含包含）」：

- **安全/平台**：`QODER_PAT` 仅经 Function 内 `Deno.env.get('QODER_PAT')` 读取，绝不进浏览器/日志/`secretNames`/普通 Secret 写入；D 零接触 PAT 链路、不新增 Secret。Deno 仅作 npm devDependency，本地门禁针对平台无关的 `functions/app.ts`。Sites 写用稳定 UUID requestId；未知结果先诊断再重试。未经新的点名授权不发布（当前发布已撤回）。M2 保持 private（public=M4）。
- **明文码仅 generate 响应展示一次**；服务端只存 SHA-256(规范化码)；日志/错误包络/details/diagnostic 绝不含码明文或哈希。
- **统一失败语义防探测**：码不存在/已被他人使用/自认领/格式非法一律 `recovery_invalid` 404 同一文案，不区分原因。
- **归属操作全部 WHERE 带 visitor 条件**；绝不触碰第三方数据。
- **无通用 DB 事务**：删除/转移用依赖顺序的幂等语句；认领锁用条件更新原子抢占 + 同认领者可重入续跑。Db 接口无 `.in()`/OR：按父 id 循环删除；null 判断用 `.is(col, null)`（fake-db `.eq(col, null)` 会抛错）。
- **范围护栏**：不改引擎/undo/preview/commit/patch/version 并发语义；不改 `requireVisitor`/平台身份链路；ENGINE_VERSION=1 不变；不做 F7.6 180 天清理（P2）、模板级联（M4 表尚不存在）、自建 token。
- **测试环境**：vitest node 环境（无 jsdom）→ 纯函数 + 后端路由单测；钩子/组件经 tsc/build + 浏览器实测。每任务 TDD：RED→看失败→GREEN→提交。
- **门禁**：`npx vitest run` 全绿 + `npm run check:function` + `npm run build`。既有 >500kB chunk 警告非错误。
- **UI 文案**：中文，沿用站点语气。`.Guidy.qoder.site` 平台再生，排除于所有提交，绝不手写。
- **不以 mock 冒充真实 AI/持久化做验收**。

## Execution Notes（执行环境事实）

- 分支：直接在 `Guidy-Qoder` 上工作（用户指令），不建 worktree、不 merge、不 push、不发布。
- 本环境 subagent 不可用（仅 context7:docs-researcher 注册）→ 按既定 fallback 内联顺序执行，TDD/门禁/自审标准不变；独立 subagent 评审不执行，终审由主会话自审完成并记录。
-  ledger：`.superpowers/sdd/2026-11-16-m3-d-identity-recovery/progress.md`（git-ignored scratch，首行写 plan 路径；每任务完成行 + 裁决行）。
- 提交只 add 计划列明的文件；`git status` 里若出现 `.Guidy.qoder.site` 变更一律不加。
- 当前基线：219 tests / 27 files 全绿。每任务结束跑全量三门禁。
- 路由测试 harness 模式见 `functions/__tests__/routes.test.ts`：`application(deps)` + `RouteCtx{request,user}`；POST body 需 `content-type: application/json`（`readJson` 强制）。
- `sha256Hex` 已存在于 `functions/sse-app.ts:19`（async，返回 hex），直接 import 复用，不重复实现。
- `readJson(request, maxBytes)` 来自 `functions/router.ts`；zod 校验失败模式：`fail('validation_failed', 422, parsed.error.flatten())`。
- `rows()` 来自 `functions/db.ts`：error→fail，data null→[]。

### fake-db / 真实 DB 已知陷阱（实现必须遵守）

1. **fake-db `.is(k,v)` 是严格相等 `row[k]===v`**：`undefined !== null`。recovery_codes 不在 TS_TABLES（无自动时间戳），insert 必须显式写 `used_at: null, claimed_by: null, overwritten_at: null, created_at: <ISO>`，否则 `.is('used_at', null)` 匹配不到。
2. **fake-db `.eq(col, null)` 直接抛错**：null 判断一律 `.is(col, null)`。
3. **删除计数用 select-before-delete**：真实 SDK delete 不带 `.select()` 时 data 为 null，不能靠 delete 返回值计数。
4. **quotas 旧行可能没有 recovery_attempts 字段**（历史 incrementChatTurn 创建的行）：`.eq('recovery_attempts', 0)` 匹配不到 undefined → CAS 永远失败。对策：两处 insertIfAbsent 都补 `recovery_attempts: 0` + 递增前对 undefined 行做一次无条件归零。
5. **quotas 有 (visitor_id, day) 唯一键**：续跑场景（overwritten_at 已置位）限流会先给当前访客重建今日行，随后转移旧访客今日行会撞唯一键。对策：`transferOwnership` 的 quotas 转移按 day 循环「先删目标同日行、再条件 UPDATE 源行」，幂等且无冲突（T2 有专门测试）。这是对 spec §2「条件 UPDATE」机制的加固，语义（旧用量随迁）不变。
6. **Db 无 `.in()`/OR**：级联删除按父 id 循环；认领锁用两步条件更新。
7. quotas/recovery_codes 无 `id` 列（quotas）——select 计数时选过滤列本身（`select(col)`），不要 `select('id')` 选不存在列。

---

### Task 1: 恢复码纯函数 functions/recovery.ts

**Files:**
- Create: `functions/recovery.ts`
- Test: `functions/__tests__/recoveryCode.test.ts`

**Interfaces:**
- Consumes: 无（全局 `crypto.getRandomValues`，Node/Deno 均可用）。
- Produces: `generateCode(): string`（32 字符 Crockford base32 原始串）；`normalizeCode(input: string): string`；`formatCode(raw: string): string`（8×4 连字符）；`isValidCode(normalized: string): boolean`。T4/T5 路由消费全部四个。

- [ ] **Step 1: 写失败测试**

Create `functions/__tests__/recoveryCode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateCode, normalizeCode, formatCode, isValidCode } from '../recovery';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('recovery code pure functions', () => {
  it('generateCode: 32 字符 Crockford base32，两次不同', () => {
    const a = generateCode();
    const b = generateCode();
    expect(a).toHaveLength(32);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
    expect(b).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
    expect(a).not.toBe(b);
  });
  it('normalizeCode: 去连字符/空格、大写、O→0 I/L→1', () => {
    expect(normalizeCode('abcd-efgh ijkl')).toBe('ABCDEFGH1JK1');
    expect(normalizeCode('oooo')).toBe('0000');
    expect(normalizeCode('il10')).toBe('1110');
    expect(normalizeCode(' 0123-4567 ')).toBe('01234567');
  });
  it('formatCode: 8 组×4 连字符', () => {
    expect(formatCode(ALPHABET)).toBe('0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ');
  });
  it('往返：normalize(format(x)) === x', () => {
    for (let i = 0; i < 20; i++) {
      const x = generateCode();
      expect(normalizeCode(formatCode(x))).toBe(x);
    }
  });
  it('isValidCode: 仅接受 32 位 Crockford 字符', () => {
    expect(isValidCode(ALPHABET)).toBe(true);
    expect(isValidCode('0'.repeat(31))).toBe(false);
    expect(isValidCode('0'.repeat(33))).toBe(false);
    expect(isValidCode('U'.repeat(32))).toBe(false);
    expect(isValidCode('0'.repeat(31) + '!')).toBe(false);
    expect(isValidCode('')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run functions/__tests__/recoveryCode.test.ts`
Expected: FAIL — `../recovery` 模块不存在（Cannot find module）。这是新函数缺失的正确 RED。

- [ ] **Step 3: 最小实现**

Create `functions/recovery.ts`:

```ts
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{32}$/;

export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function normalizeCode(input: string): string {
  return input.replace(/[-\s]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function formatCode(raw: string): string {
  return (raw.match(/.{4}/g) ?? []).join('-');
}

export function isValidCode(normalized: string): boolean {
  return CODE_RE.test(normalized);
}
```

说明：20 字节 = 160 bit = 恰好 32×5 bit，无余位；`value` 峰值 <2^13，位运算安全。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run functions/__tests__/recoveryCode.test.ts`
Expected: PASS（5 tests）。

- [ ] **Step 5: 全量门禁**

Run: `npx vitest run` → 全绿（224 tests / 28 files）。
Run: `npm run check:function` → 无错误。
Run: `npm run build` → 成功（>500kB chunk 警告为既有非错误）。

- [ ] **Step 6: Commit**

```bash
git add functions/recovery.ts functions/__tests__/recoveryCode.test.ts
git commit -m "feat(recovery): code generation/normalization pure functions"
```

---

### Task 2: 归属操作核心 functions/ownership.ts

**Files:**
- Create: `functions/ownership.ts`
- Test: `functions/__tests__/ownership.test.ts`

**Interfaces:**
- Consumes: `Db`/`rows`（`functions/db.ts`）；fake-db（`dev/fake-db.ts`，测试用）。
- Produces: `deleteVisitorData(db: Db, visitor: string): Promise<Record<string, number>>`（键固定为 messages/dispatch_intents/blocks/task_defs/constraints/commit_log/conversations/plans/quotas/recovery_codes）；`transferOwnership(db: Db, from: string, to: string): Promise<{ plans_count: number; conversations_count: number }>`。T5 claim、T6 deleteAll 消费。

- [ ] **Step 1: 写失败测试**

Create `functions/__tests__/ownership.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../dev/fake-db';
import { deleteVisitorData, transferOwnership } from '../ownership';

function seedDb() {
  return createMemoryDb({
    plans: [
      { id: 'p1', owner_visitor_id: 'o', title: '旧计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
      { id: 'p2', owner_visitor_id: 'x', title: '第三方', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
    ],
    blocks: [{ id: 'b1', plan_id: 'p1', title: '块', start_utc: '2026-11-16T01:00:00Z', end_utc: '2026-11-16T02:00:00Z' }],
    task_defs: [{ id: 't1', plan_id: 'p1', key: 'k', title: '任务', category: 'study', duration_min: 60, frequency: { type: 'daily' } }],
    constraints: [{ id: 'k1', plan_id: 'p1', type: 'active_window', start: '07:00', end: '23:00' }],
    conversations: [
      { id: 'cv1', owner_visitor_id: 'o', plan_id: 'p1', qca_session_id: 's1', last_seq: 0, last_event_id: null },
      { id: 'cv2', owner_visitor_id: 'x', plan_id: 'p2', qca_session_id: 's2', last_seq: 0, last_event_id: null },
    ],
    messages: [
      { id: 'm1', conversation_id: 'cv1', seq: 1, role: 'user', text: '你好' },
      { id: 'm2', conversation_id: 'cv2', seq: 1, role: 'user', text: '第三方' },
    ],
    dispatch_intents: [{ request_id: 'r1', visitor_id: 'o', status: 'completed' }],
    commit_log: [{ preview_id: 'pv1', visitor_id: 'o', plan_id: 'p1' }],
    quotas: [
      { visitor_id: 'o', day: '2026-11-16', chat_turns: 5, publishes: 0, recovery_attempts: 0 },
      { visitor_id: 'x', day: '2026-11-16', chat_turns: 1, publishes: 0, recovery_attempts: 0 },
    ],
    recovery_codes: [{ id: 'rc1', visitor_id: 'o', code_hash: 'h1', used_at: null, claimed_by: null, overwritten_at: null, created_at: '2026-11-16T00:00:00Z' }],
  });
}

describe('deleteVisitorData', () => {
  it('按依赖顺序清空该 visitor 全部表，第三方零影响', async () => {
    const db = seedDb();
    const counts = await deleteVisitorData(db, 'o');
    expect(counts).toEqual({
      messages: 1, dispatch_intents: 1, blocks: 1, task_defs: 1, constraints: 1,
      commit_log: 1, conversations: 1, plans: 1, quotas: 1, recovery_codes: 1,
    });
    expect(db.tables.plans.map((p) => p.id)).toEqual(['p2']);
    expect(db.tables.messages.map((m) => m.id)).toEqual(['m2']);
    expect(db.tables.conversations.map((c) => c.id)).toEqual(['cv2']);
    expect(db.tables.quotas).toHaveLength(1);
    expect(db.tables.quotas[0].visitor_id).toBe('x');
    expect(db.tables.recovery_codes).toHaveLength(0);
    expect(db.tables.dispatch_intents).toHaveLength(0);
    expect(db.tables.commit_log).toHaveLength(0);
    expect(db.tables.blocks).toHaveLength(0);
    expect(db.tables.task_defs).toHaveLength(0);
    expect(db.tables.constraints).toHaveLength(0);
  });
  it('幂等：重跑计数全 0', async () => {
    const db = seedDb();
    await deleteVisitorData(db, 'o');
    const counts = await deleteVisitorData(db, 'o');
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});

describe('transferOwnership', () => {
  it('只动 from→to 的 owner 列，子表经父 id 跟随，第三方零影响', async () => {
    const db = seedDb();
    const counts = await transferOwnership(db, 'o', 'c');
    expect(counts).toEqual({ plans_count: 1, conversations_count: 1 });
    expect(db.tables.plans.find((p) => p.id === 'p1').owner_visitor_id).toBe('c');
    expect(db.tables.conversations.find((c) => c.id === 'cv1').owner_visitor_id).toBe('c');
    expect(db.tables.blocks[0].plan_id).toBe('p1');
    expect(db.tables.messages.find((m) => m.id === 'm1').conversation_id).toBe('cv1');
    expect(db.tables.quotas.find((q) => q.visitor_id === 'c').chat_turns).toBe(5);
    expect(db.tables.dispatch_intents[0].visitor_id).toBe('c');
    expect(db.tables.commit_log[0].visitor_id).toBe('c');
    expect(db.tables.plans.find((p) => p.id === 'p2').owner_visitor_id).toBe('x');
    expect(db.tables.messages.find((m) => m.id === 'm2').conversation_id).toBe('cv2');
    expect(db.tables.quotas.find((q) => q.visitor_id === 'x').chat_turns).toBe(1);
  });
  it('幂等：重跑转移 0 行', async () => {
    const db = seedDb();
    await transferOwnership(db, 'o', 'c');
    expect(await transferOwnership(db, 'o', 'c')).toEqual({ plans_count: 0, conversations_count: 0 });
  });
  it('quotas 转移防撞唯一键：目标已有同日行时先删目标行再转移，旧用量胜出', async () => {
    const db = createMemoryDb({
      quotas: [
        { visitor_id: 'o', day: '2026-11-16', chat_turns: 7, publishes: 1, recovery_attempts: 2 },
        { visitor_id: 'c', day: '2026-11-16', chat_turns: 0, publishes: 0, recovery_attempts: 1 },
      ],
    });
    await transferOwnership(db, 'o', 'c');
    const rowsC = db.tables.quotas.filter((q) => q.visitor_id === 'c');
    expect(rowsC).toHaveLength(1);
    expect(rowsC[0].chat_turns).toBe(7);
    expect(rowsC[0].publishes).toBe(1);
    expect(db.tables.quotas.some((q) => q.visitor_id === 'o')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run functions/__tests__/ownership.test.ts`
Expected: FAIL — `../ownership` 模块不存在。

- [ ] **Step 3: 最小实现**

Create `functions/ownership.ts`:

```ts
import { rows } from './db.ts';
import type { Db } from './db.ts';

async function deleteWhere(db: Db, table: string, col: string, val: string): Promise<number> {
  const n = rows(await db.from(table).select(col).eq(col, val)).length;
  if (n) rows(await db.from(table).delete().eq(col, val));
  return n;
}

export async function deleteVisitorData(db: Db, visitor: string): Promise<Record<string, number>> {
  const planIds = rows(await db.from('plans').select('id').eq('owner_visitor_id', visitor)).map((p) => p.id);
  const convIds = rows(await db.from('conversations').select('id').eq('owner_visitor_id', visitor)).map((c) => c.id);
  const deleted: Record<string, number> = {
    messages: 0, dispatch_intents: 0, blocks: 0, task_defs: 0, constraints: 0,
    commit_log: 0, conversations: 0, plans: 0, quotas: 0, recovery_codes: 0,
  };
  for (const cid of convIds) deleted.messages += await deleteWhere(db, 'messages', 'conversation_id', cid);
  deleted.dispatch_intents = await deleteWhere(db, 'dispatch_intents', 'visitor_id', visitor);
  for (const pid of planIds) {
    deleted.blocks += await deleteWhere(db, 'blocks', 'plan_id', pid);
    deleted.task_defs += await deleteWhere(db, 'task_defs', 'plan_id', pid);
    deleted.constraints += await deleteWhere(db, 'constraints', 'plan_id', pid);
  }
  deleted.commit_log = await deleteWhere(db, 'commit_log', 'visitor_id', visitor);
  deleted.conversations = await deleteWhere(db, 'conversations', 'owner_visitor_id', visitor);
  deleted.plans = await deleteWhere(db, 'plans', 'owner_visitor_id', visitor);
  deleted.quotas = await deleteWhere(db, 'quotas', 'visitor_id', visitor);
  deleted.recovery_codes = await deleteWhere(db, 'recovery_codes', 'visitor_id', visitor);
  return deleted;
}

export async function transferOwnership(db: Db, from: string, to: string): Promise<{ plans_count: number; conversations_count: number }> {
  const plans = rows(await db.from('plans').update({ owner_visitor_id: to }).eq('owner_visitor_id', from).select('id'));
  const conversations = rows(await db.from('conversations').update({ owner_visitor_id: to }).eq('owner_visitor_id', from).select('id'));
  rows(await db.from('dispatch_intents').update({ visitor_id: to }).eq('visitor_id', from).select('request_id'));
  rows(await db.from('commit_log').update({ visitor_id: to }).eq('visitor_id', from).select('preview_id'));
  // quotas 有 (visitor_id, day) 唯一键：续跑时限流可能已给 to 重建今日行，
  // 直接 UPDATE 会撞键。按 day 先删 to 的同日行再转移 from 的行，幂等无冲突。
  const quotaDays = rows(await db.from('quotas').select('day').eq('visitor_id', from)).map((q) => q.day);
  for (const day of quotaDays) {
    rows(await db.from('quotas').delete().eq('visitor_id', to).eq('day', day));
    rows(await db.from('quotas').update({ visitor_id: to }).eq('visitor_id', from).eq('day', day).select('day'));
  }
  return { plans_count: plans.length, conversations_count: conversations.length };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run functions/__tests__/ownership.test.ts`
Expected: PASS（5 tests）。特别确认防撞键测试：若实现写成无条件 UPDATE，该测试会因 rowsC 长度 2 而失败。

- [ ] **Step 5: 全量门禁**

Run: `npx vitest run` → 全绿（229 tests / 29 files）。
Run: `npm run check:function` → 无错误。
Run: `npm run build` → 成功。

- [ ] **Step 6: Commit**

```bash
git add functions/ownership.ts functions/__tests__/ownership.test.ts
git commit -m "feat(recovery): visitor data delete/ownership transfer core"
```

---

### Task 3: 迁移 0002 + 错误码 + 恢复尝试配额

**Files:**
- Create: `functions/migrations/0002_recovery.sql`
- Create: `functions/__tests__/recovery.test.ts`（本任务只含配额测试；T4/T5 追加路由测试）
- Modify: `functions/errors.ts`（MESSAGES 表追加两行）
- Modify: `shared/constants.ts:52`（QUOTAS 追加 recoveryAttemptsPerDay）
- Modify: `functions/quotas.ts`（incrementChatTurn 的 insertIfAbsent 补字段 + 新增 incrementRecoveryAttempt）

**Interfaces:**
- Consumes: `Db`/`rows`/`fail`/`QUOTAS`（现有）。
- Produces: `incrementRecoveryAttempt(db: Db, visitor: string, day: string, limit?: number): Promise<void>`（超限抛 `recovery_rate_limited` 429 details `{limit}`；CAS 5 轮失败抛 503）；错误码 `recovery_invalid`/`recovery_rate_limited` 文案；`QUOTAS.recoveryAttemptsPerDay = 10`。T5 消费。
- 迁移 SQL 仅 DDL，本任务不应用到 Sites（发布需新的点名授权，当前撤回）。

- [ ] **Step 1: 写失败测试**

Create `functions/__tests__/recovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../dev/fake-db';
import { incrementRecoveryAttempt, incrementChatTurn } from '../quotas';

describe('recovery attempt quota', () => {
  it('每日 10 次允许，第 11 次 → recovery_rate_limited 429', async () => {
    const db = createMemoryDb();
    for (let i = 0; i < 10; i++) await incrementRecoveryAttempt(db, 'v', '2026-11-16');
    await expect(incrementRecoveryAttempt(db, 'v', '2026-11-16')).rejects.toMatchObject({ code: 'recovery_rate_limited', status: 429 });
    expect(db.tables.quotas[0].recovery_attempts).toBe(10);
  });
  it('历史行缺 recovery_attempts 字段：归一化后递增，chat_turns/publishes 保留', async () => {
    const db = createMemoryDb({ quotas: [{ visitor_id: 'v', day: '2026-11-16', chat_turns: 7, publishes: 1 }] });
    await incrementRecoveryAttempt(db, 'v', '2026-11-16');
    const row = db.tables.quotas[0];
    expect(row.recovery_attempts).toBe(1);
    expect(row.chat_turns).toBe(7);
    expect(row.publishes).toBe(1);
  });
  it('chat 创建的 quotas 行自带 recovery_attempts 字段，随后递增正常', async () => {
    const db = createMemoryDb();
    await incrementChatTurn(db, 'v', '2026-11-16');
    expect(db.tables.quotas[0].recovery_attempts).toBe(0);
    await incrementRecoveryAttempt(db, 'v', '2026-11-16');
    expect(db.tables.quotas[0].recovery_attempts).toBe(1);
    expect(db.tables.quotas[0].chat_turns).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run functions/__tests__/recovery.test.ts`
Expected: FAIL — `incrementRecoveryAttempt` 未从 `../quotas` 导出。

- [ ] **Step 3: 实现**

3a. Create `functions/migrations/0002_recovery.sql`（逐字来自 spec §1）:

```sql
CREATE TABLE app.recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id text NOT NULL,
  code_hash text NOT NULL UNIQUE,
  used_at timestamptz,
  claimed_by text,
  overwritten_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_visitor_idx ON app.recovery_codes (visitor_id);
ALTER TABLE app.quotas ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0;
```

3b. Modify `functions/errors.ts` — 在 MESSAGES 表 `invalid_input` 行之后追加：

```ts
  recovery_invalid: '恢复码无效或已被使用',
  recovery_rate_limited: '今日恢复尝试次数已用完，请明天再来',
```

3c. Modify `shared/constants.ts:52` — 替换为：

```ts
export const QUOTAS = { chatTurnsPerDay: 60, publishesPerDay: 3, recoveryAttemptsPerDay: 10 };
```

3d. Modify `functions/quotas.ts` — incrementChatTurn 的 insertIfAbsent 行替换为（补 recovery_attempts 字段）：

```ts
  rows(await db.from('quotas').insertIfAbsent({ visitor_id: visitor, day, chat_turns: 0, publishes: 0, recovery_attempts: 0 }, { onConflict: 'visitor_id,day' }));
```

并在文件末尾（assertNoPendingDispatch 之后）追加：

```ts
export async function incrementRecoveryAttempt(db: Db, visitor: string, day: string, limit = QUOTAS.recoveryAttemptsPerDay): Promise<void> {
  rows(await db.from('quotas').insertIfAbsent({ visitor_id: visitor, day, chat_turns: 0, publishes: 0, recovery_attempts: 0 }, { onConflict: 'visitor_id,day' }));
  const existing = rows(await db.from('quotas').select('recovery_attempts').eq('visitor_id', visitor).eq('day', day).limit(1))[0];
  if (existing && existing.recovery_attempts === undefined) {
    rows(await db.from('quotas').update({ recovery_attempts: 0 }).eq('visitor_id', visitor).eq('day', day));
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = rows(await db.from('quotas').select('recovery_attempts').eq('visitor_id', visitor).eq('day', day).limit(1))[0]?.recovery_attempts ?? 0;
    if (current >= limit) fail('recovery_rate_limited', 429, { limit });
    const updated = rows(await db.from('quotas').update({ recovery_attempts: current + 1 }).eq('visitor_id', visitor).eq('day', day).eq('recovery_attempts', current).select('recovery_attempts'));
    if (updated.length) return;
  }
  fail('service_unavailable', 503);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run functions/__tests__/recovery.test.ts`
Expected: PASS（3 tests）。
Run: `npx vitest run functions/__tests__/routes.test.ts`
Expected: PASS（既有 R13 配额测试不受 insertIfAbsent 补字段影响）。

- [ ] **Step 5: 全量门禁**

Run: `npx vitest run` → 全绿（232 tests / 30 files）。
Run: `npm run check:function` → 无错误。
Run: `npm run build` → 成功。

- [ ] **Step 6: Commit**

```bash
git add functions/migrations/0002_recovery.sql functions/errors.ts shared/constants.ts functions/quotas.ts functions/__tests__/recovery.test.ts
git commit -m "feat(recovery): migration 0002 + recovery attempt quota + error codes"
```

---

### Task 4: generate 路由 + me.has_recovery_code 接真

**Files:**
- Create: `functions/routes/recovery.ts`（本任务只含 recoveryGenerate；T5 追加 recoveryClaim）
- Modify: `functions/routes/me.ts:13`（has_recovery_code 占位接真）
- Modify: `functions/app.ts`（import + 注册 POST /api/recovery/generate）
- Test: `functions/__tests__/recovery.test.ts`（追加 imports + harness + generate describe 块）

**Interfaces:**
- Consumes: T1 `generateCode/normalizeCode/formatCode`；`sha256Hex`（`functions/sse-app.ts`）；`requireVisitor`；`rows`。
- Produces: `recoveryGenerate(ctx: RouteCtx, deps: Deps): Promise<Response>` → 200 `{ code: string }`（8×4 明文，仅此一次）；DB 行 `{ visitor_id, code_hash, used_at: null, claimed_by: null, overwritten_at: null, created_at }`；`GET /api/me` 返回 `has_recovery_code: boolean`。T5/T7/T8 消费。

- [ ] **Step 1: 写失败测试**

在 `functions/__tests__/recovery.test.ts` 顶部 imports 区追加：

```ts
import { application } from '../app';
import type { Deps, RouteCtx } from '../types';
import { createFakeQca } from '../../dev/fake-qca';
import { sha256Hex } from '../sse-app';
import { normalizeCode } from '../recovery';
```

在文件末尾追加 harness 与测试（harness 供 T5 复用）：

```ts
function setup(seed: Record<string, any[]> = {}) {
  const db = createMemoryDb(seed);
  const deps: Deps = {
    db,
    requireUser: (ctx) => { if (!ctx.user) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); return ctx.user; },
    qca: createFakeQca(),
    config: { cloudApiOrigin: 'https://api.qoder.com.cn', appScope: 'guidy-test', modelId: 'model-fake' },
  };
  return { db, app: application(deps) };
}
function req(method: string, path: string, body?: unknown, user: { id: string } | null = { id: 'visitor-a' }): RouteCtx {
  return {
    request: new Request(`http://127.0.0.1:8000/functions/v1/app${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    user,
  };
}
async function generateFor(app: ReturnType<typeof application>, visitor: string): Promise<string> {
  const res = await app(req('POST', '/api/recovery/generate', undefined, { id: visitor }));
  expect(res.status).toBe(200);
  return (await res.json()).code as string;
}

describe('POST /api/recovery/generate', () => {
  it('200 返回 8×4 明文码；DB 只存哈希，null 字段显式置位', async () => {
    const { db, app } = setup();
    const res = await app(req('POST', '/api/recovery/generate'));
    expect(res.status).toBe(200);
    const { code } = await res.json();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(db.tables.recovery_codes).toHaveLength(1);
    const row = db.tables.recovery_codes[0];
    expect(row.visitor_id).toBe('visitor-a');
    expect(row.code_hash).toBe(await sha256Hex(normalizeCode(code)));
    expect(row.code_hash).not.toBe(normalizeCode(code));
    expect(row.used_at).toBeNull();
    expect(row.claimed_by).toBeNull();
    expect(row.overwritten_at).toBeNull();
    expect(typeof row.created_at).toBe('string');
  });
  it('单活码：重新生成替换旧码行', async () => {
    const { db, app } = setup();
    const first = await generateFor(app, 'visitor-a');
    const second = await generateFor(app, 'visitor-a');
    expect(db.tables.recovery_codes).toHaveLength(1);
    expect(db.tables.recovery_codes[0].code_hash).toBe(await sha256Hex(normalizeCode(second)));
    expect(db.tables.recovery_codes[0].code_hash).not.toBe(await sha256Hex(normalizeCode(first)));
  });
  it('me.has_recovery_code 随有效码存在与否变化', async () => {
    const { app } = setup();
    expect((await (await app(req('GET', '/api/me'))).json()).has_recovery_code).toBe(false);
    await generateFor(app, 'visitor-a');
    expect((await (await app(req('GET', '/api/me'))).json()).has_recovery_code).toBe(true);
  });
  it('无身份 → 401', async () => {
    const { app } = setup();
    const res = await app(req('POST', '/api/recovery/generate', undefined, null));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run functions/__tests__/recovery.test.ts`
Expected: 新增 generate 测试 FAIL — 路由未注册，返回 404 `not_found`（generateFor 内 expect 200 失败）；me 测试 FAIL — has_recovery_code 恒 false。既有配额测试仍 PASS。

- [ ] **Step 3: 实现**

3a. Create `functions/routes/recovery.ts`:

```ts
import { rows } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { generateCode, normalizeCode, formatCode } from '../recovery.ts';
import { sha256Hex } from '../sse-app.ts';
import type { Deps, RouteCtx } from '../types.ts';

export async function recoveryGenerate(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  rows(await deps.db.from('recovery_codes').delete().eq('visitor_id', visitor));
  const raw = generateCode();
  const code_hash = await sha256Hex(normalizeCode(raw));
  rows(await deps.db.from('recovery_codes').insert({
    visitor_id: visitor,
    code_hash,
    used_at: null,
    claimed_by: null,
    overwritten_at: null,
    created_at: (deps.now?.() ?? new Date()).toISOString(),
  }));
  return Response.json({ code: formatCode(raw) });
}
```

注意：insert 必须显式写三个 null 字段（fake-db `.is` 严格相等，undefined≠null）；recovery_codes 不在 fake-db TS_TABLES，created_at 显式写。

3b. Modify `functions/routes/me.ts` — 在 `const q = ...` 行之后追加：

```ts
  const hasCode = rows(await deps.db.from('recovery_codes').select('id').eq('visitor_id', visitor).is('used_at', null).limit(1)).length > 0;
```

并把响应中 `has_recovery_code: false,` 替换为 `has_recovery_code: hasCode,`。

3c. Modify `functions/app.ts` — import 区追加：

```ts
import { recoveryGenerate } from './routes/recovery.ts';
```

routes 数组末尾（DELETE /plans 行之后）追加：

```ts
    { method: 'POST', pattern: /^\/api\/recovery\/generate$/, handler: recoveryGenerate },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run functions/__tests__/recovery.test.ts`
Expected: PASS（7 tests）。

- [ ] **Step 5: 全量门禁**

Run: `npx vitest run` → 全绿（236 tests / 30 files）。
Run: `npm run check:function` → 无错误。
Run: `npm run build` → 成功。

- [ ] **Step 6: Commit**

```bash
git add functions/routes/recovery.ts functions/routes/me.ts functions/app.ts functions/__tests__/recovery.test.ts
git commit -m "feat(recovery): generate route + me has_recovery_code wiring"
```

---

### Task 5: claim 路由（认领锁 + 阶段标记续跑 + 限流）

**Files:**
- Modify: `functions/routes/recovery.ts`（追加 recoveryClaim + imports）
- Modify: `functions/app.ts`（注册 POST /api/recovery/claim）
- Test: `functions/__tests__/recovery.test.ts`（追加 claim describe 块 + oldDeviceSeed）

**Interfaces:**
- Consumes: T1 四个纯函数；T2 `deleteVisitorData/transferOwnership`；T3 `incrementRecoveryAttempt`；`assertNoPendingDispatch/todayStr`（quotas）；`readJson`（router）；`sha256Hex`；`fail`。
- Produces: `recoveryClaim(ctx: RouteCtx, deps: Deps): Promise<Response>`；`POST /api/recovery/claim` body `{ code: string, strategy: 'overwrite' }` → 200 `{ ok: true, plans_count, conversations_count }`；失败：422 validation_failed（zod 字段级）/ 404 recovery_invalid（统一）/ 429 recovery_rate_limited / 409 dispatch_busy。T7 api 客户端消费。

- [ ] **Step 1: 写失败测试**

在 `functions/__tests__/recovery.test.ts` 末尾追加（`TODAY` 用真实当天，与路由 `todayStr(new Date())` 一致）：

```ts
const TODAY = new Date().toISOString().slice(0, 10);
function oldDeviceSeed() {
  return {
    plans: [
      { id: 'p-old', owner_visitor_id: 'visitor-old', title: '旧设备计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
      { id: 'p-cur', owner_visitor_id: 'visitor-a', title: '当前设备计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
      { id: 'p-x', owner_visitor_id: 'visitor-x', title: '第三方计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
    ],
    conversations: [
      { id: 'c-old', owner_visitor_id: 'visitor-old', plan_id: 'p-old', qca_session_id: 's-old', last_seq: 2, last_event_id: 'e2' },
      { id: 'c-x', owner_visitor_id: 'visitor-x', plan_id: 'p-x', qca_session_id: 's-x', last_seq: 0, last_event_id: null },
    ],
    messages: [
      { id: 'm-old', conversation_id: 'c-old', seq: 1, role: 'user', text: '旧对话' },
      { id: 'm-x', conversation_id: 'c-x', seq: 1, role: 'user', text: '第三方' },
    ],
    blocks: [{ id: 'b-old', plan_id: 'p-old', title: '旧块', start_utc: '2026-11-16T01:00:00Z', end_utc: '2026-11-16T02:00:00Z' }],
    task_defs: [{ id: 't-old', plan_id: 'p-old', key: 'k', title: '旧任务', category: 'study', duration_min: 60, frequency: { type: 'daily' } }],
    constraints: [{ id: 'k-old', plan_id: 'p-old', type: 'active_window', start: '07:00', end: '23:00' }],
    commit_log: [{ preview_id: 'pv-old', visitor_id: 'visitor-old', plan_id: 'p-old' }],
    quotas: [
      { visitor_id: 'visitor-old', day: TODAY, chat_turns: 7, publishes: 1, recovery_attempts: 0 },
      { visitor_id: 'visitor-a', day: TODAY, chat_turns: 3, publishes: 0, recovery_attempts: 0 },
    ],
  };
}

describe('POST /api/recovery/claim', () => {
  it('黄金路径：覆盖删除 + 全部归属转移 + 配额随迁 + 锁字段置位 + 第三方零影响', async () => {
    const { db, app } = setup(oldDeviceSeed());
    const code = await generateFor(app, 'visitor-old');
    const res = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plans_count: 1, conversations_count: 1 });
    expect(db.tables.plans.find((p) => p.id === 'p-old').owner_visitor_id).toBe('visitor-a');
    expect(db.tables.plans.find((p) => p.id === 'p-cur')).toBeUndefined();
    expect(db.tables.plans.find((p) => p.id === 'p-x').owner_visitor_id).toBe('visitor-x');
    expect(db.tables.conversations.find((c) => c.id === 'c-old').owner_visitor_id).toBe('visitor-a');
    expect(db.tables.messages.find((m) => m.id === 'm-old').conversation_id).toBe('c-old');
    expect(db.tables.messages.find((m) => m.id === 'm-x')).toBeTruthy();
    expect(db.tables.blocks[0].plan_id).toBe('p-old');
    expect(db.tables.commit_log[0].visitor_id).toBe('visitor-a');
    const qa = db.tables.quotas.filter((q) => q.visitor_id === 'visitor-a');
    expect(qa).toHaveLength(1);
    expect(qa[0].chat_turns).toBe(7);
    expect(db.tables.quotas.some((q) => q.visitor_id === 'visitor-old')).toBe(false);
    const rc = db.tables.recovery_codes[0];
    expect(rc.used_at).toBeTruthy();
    expect(rc.claimed_by).toBe('visitor-a');
    expect(rc.overwritten_at).toBeTruthy();
    const oldPlans = await (await app(req('GET', '/api/plans', undefined, { id: 'visitor-old' }))).json();
    expect(oldPlans.items).toHaveLength(0);
    const meA = await (await app(req('GET', '/api/me'))).json();
    expect(meA.quotas.chat_remaining).toBe(53);
    expect(meA.has_recovery_code).toBe(false);
  });
  it('错码/格式非法/自认领 → 统一 404 recovery_invalid，不回显码', async () => {
    const { app } = setup();
    const bogus = '0000-0000-0000-0000-0000-0000-0000-0000';
    const res = await app(req('POST', '/api/recovery/claim', { code: bogus, strategy: 'overwrite' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('recovery_invalid');
    expect(body.error.message).toBe('恢复码无效或已被使用');
    expect(body.error.details).toBeUndefined();
    const bad = await app(req('POST', '/api/recovery/claim', { code: 'abc', strategy: 'overwrite' }));
    expect(bad.status).toBe(404);
    expect((await bad.json()).error.code).toBe('recovery_invalid');
    const mine = await generateFor(app, 'visitor-a');
    const self = await app(req('POST', '/api/recovery/claim', { code: mine, strategy: 'overwrite' }));
    expect(self.status).toBe(404);
    expect((await self.json()).error.code).toBe('recovery_invalid');
  });
  it('缺 strategy / strategy 非 overwrite → 422 validation_failed', async () => {
    const { app } = setup();
    const noStrategy = await app(req('POST', '/api/recovery/claim', { code: '0'.repeat(32) }));
    expect(noStrategy.status).toBe(422);
    expect((await noStrategy.json()).error.code).toBe('validation_failed');
    const merge = await app(req('POST', '/api/recovery/claim', { code: '0'.repeat(32), strategy: 'merge' }));
    expect(merge.status).toBe(422);
    expect((await merge.json()).error.code).toBe('validation_failed');
  });
  it('第 11 次尝试 → 429 recovery_rate_limited（验证前计数）', async () => {
    const { app } = setup();
    const bogus = { code: '0'.repeat(32), strategy: 'overwrite' };
    for (let i = 0; i < 10; i++) {
      expect((await app(req('POST', '/api/recovery/claim', bogus))).status).toBe(404);
    }
    const res = await app(req('POST', '/api/recovery/claim', bogus));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('recovery_rate_limited');
    expect(body.error.details).toEqual({ limit: 10 });
  });
  it('pending 派发 → 409 dispatch_busy 且码未消费', async () => {
    const { db, app } = setup({ dispatch_intents: [{ request_id: 'r-pending', visitor_id: 'visitor-a', status: 'pending' }] });
    const code = await generateFor(app, 'visitor-old');
    const res = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('dispatch_busy');
    expect(db.tables.recovery_codes[0].used_at).toBeNull();
    expect(db.tables.recovery_codes[0].claimed_by).toBeNull();
  });
  it('已被他人认领 → 统一 404', async () => {
    const { app } = setup(oldDeviceSeed());
    const code = await generateFor(app, 'visitor-old');
    const first = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }, { id: 'visitor-b' }));
    expect(first.status).toBe(200);
    const second = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }, { id: 'visitor-c' }));
    expect(second.status).toBe(404);
    expect((await second.json()).error.code).toBe('recovery_invalid');
  });
  it('续跑（标记后崩溃）：已转移数据绝不被覆盖删除误伤，补齐剩余转移', async () => {
    const seed = oldDeviceSeed();
    seed.plans.push({ id: 'p-old2', owner_visitor_id: 'visitor-old', title: '旧计划2', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 });
    const { db, app } = setup(seed);
    const code = await generateFor(app, 'visitor-old');
    const rc = db.tables.recovery_codes[0];
    rc.used_at = '2026-11-16T00:00:00Z';
    rc.claimed_by = 'visitor-a';
    rc.overwritten_at = '2026-11-16T00:00:01Z';
    db.tables.plans = db.tables.plans.filter((p) => p.id !== 'p-cur');
    db.tables.quotas = db.tables.quotas.filter((q) => q.visitor_id !== 'visitor-a');
    db.tables.plans.find((p) => p.id === 'p-old').owner_visitor_id = 'visitor-a';
    const res = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }));
    expect(res.status).toBe(200);
    expect(db.tables.plans.find((p) => p.id === 'p-old').owner_visitor_id).toBe('visitor-a');
    expect(db.tables.plans.find((p) => p.id === 'p-old2').owner_visitor_id).toBe('visitor-a');
    expect(db.tables.conversations.find((c) => c.id === 'c-old').owner_visitor_id).toBe('visitor-a');
    const qa = db.tables.quotas.filter((q) => q.visitor_id === 'visitor-a');
    expect(qa).toHaveLength(1);
    expect(qa[0].chat_turns).toBe(7);
  });
  it('续跑（标记前崩溃）：补齐覆盖删除后再转移', async () => {
    const seed = oldDeviceSeed();
    seed.plans.push({ id: 'p-cur2', owner_visitor_id: 'visitor-a', title: '当前计划2', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 });
    const { db, app } = setup(seed);
    const code = await generateFor(app, 'visitor-old');
    const rc = db.tables.recovery_codes[0];
    rc.used_at = '2026-11-16T00:00:00Z';
    rc.claimed_by = 'visitor-a';
    db.tables.plans = db.tables.plans.filter((p) => p.id !== 'p-cur');
    const res = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }));
    expect(res.status).toBe(200);
    expect(db.tables.plans.find((p) => p.id === 'p-cur2')).toBeUndefined();
    expect(db.tables.plans.find((p) => p.id === 'p-old').owner_visitor_id).toBe('visitor-a');
    expect(db.tables.recovery_codes[0].overwritten_at).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run functions/__tests__/recovery.test.ts`
Expected: 新增 claim 测试 FAIL — 路由未注册返回 404 `not_found`（黄金路径 expect 200 失败；统一语义测试 error.code 为 not_found ≠ recovery_invalid）。既有测试仍 PASS。

- [ ] **Step 3: 实现**

3a. Modify `functions/routes/recovery.ts` — imports 区替换为：

```ts
import { z } from 'npm:zod@3.25.76';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { generateCode, normalizeCode, formatCode, isValidCode } from '../recovery.ts';
import { sha256Hex } from '../sse-app.ts';
import { todayStr, incrementRecoveryAttempt, assertNoPendingDispatch } from '../quotas.ts';
import { deleteVisitorData, transferOwnership } from '../ownership.ts';
import type { Deps, RouteCtx } from '../types.ts';

const ClaimSchema = z.object({ code: z.string().min(1), strategy: z.literal('overwrite') });
```

文件末尾追加：

```ts
export async function recoveryClaim(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 4096);
  const parsed = ClaimSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const day = todayStr(deps.now?.() ?? new Date());
  await incrementRecoveryAttempt(deps.db, visitor, day);
  const normalized = normalizeCode(parsed.data.code);
  if (!isValidCode(normalized)) fail('recovery_invalid', 404);
  const code_hash = await sha256Hex(normalized);
  const codeRow = rows(await deps.db.from('recovery_codes').select('*').eq('code_hash', code_hash).limit(1))[0];
  if (!codeRow || codeRow.visitor_id === visitor) fail('recovery_invalid', 404);
  await assertNoPendingDispatch(deps.db, visitor);
  const now = (deps.now?.() ?? new Date()).toISOString();
  let locked = rows(await deps.db.from('recovery_codes').update({ used_at: now, claimed_by: visitor }).eq('id', codeRow.id).is('used_at', null).select('*'));
  if (!locked.length) locked = rows(await deps.db.from('recovery_codes').update({ claimed_by: visitor }).eq('id', codeRow.id).eq('claimed_by', visitor).select('*'));
  if (!locked.length) fail('recovery_invalid', 404);
  const row = locked[0];
  if (row.overwritten_at === null || row.overwritten_at === undefined) {
    await deleteVisitorData(deps.db, visitor);
    rows(await deps.db.from('recovery_codes').update({ overwritten_at: now }).eq('id', row.id).eq('claimed_by', visitor).select('id'));
  }
  const counts = await transferOwnership(deps.db, row.visitor_id, visitor);
  return Response.json({ ok: true, ...counts });
}
```

顺序不变量（spec §3）：限流在验证前；pending 守卫在锁前（忙时不消费码）；删除只在 overwritten_at 置位前、转移只在置位后；锁第二步允许同认领者续跑。

3b. Modify `functions/app.ts` — import 行改为：

```ts
import { recoveryGenerate, recoveryClaim } from './routes/recovery.ts';
```

routes 数组 generate 行之后追加：

```ts
    { method: 'POST', pattern: /^\/api\/recovery\/claim$/, handler: recoveryClaim },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run functions/__tests__/recovery.test.ts`
Expected: PASS（15 tests）。两个续跑测试是崩溃安全的核心回归守卫，必须绿。

- [ ] **Step 5: 全量门禁**

Run: `npx vitest run` → 全绿（244 tests / 30 files）。
Run: `npm run check:function` → 无错误。
Run: `npm run build` → 成功。

- [ ] **Step 6: Commit**

```bash
git add functions/routes/recovery.ts functions/app.ts functions/__tests__/recovery.test.ts
git commit -m "feat(recovery): claim route with lock/resume/rate-limit"
```

---

### Task 6: delete-all 路由

**Files:**
- Create: `functions/routes/data.ts`
- Modify: `functions/app.ts`（注册 POST /api/data/delete-all）
- Test: `functions/__tests__/data.test.ts`

**Interfaces:**
- Consumes: T2 `deleteVisitorData`；`assertNoPendingDispatch`；`readJson`；`requireVisitor`；`fail`。
- Produces: `deleteAll(ctx: RouteCtx, deps: Deps): Promise<Response>`；`POST /api/data/delete-all` body `{ confirm_token: 'DELETE' }` → 200 `{ ok: true, deleted: Record<string, number> }`；422/409/401。T7 api 客户端消费。

- [ ] **Step 1: 写失败测试**

Create `functions/__tests__/data.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { application } from '../app';
import type { Deps, RouteCtx } from '../types';
import { createFakeQca } from '../../dev/fake-qca';
import { createMemoryDb } from '../../dev/fake-db';

function setup(seed: Record<string, any[]> = {}) {
  const db = createMemoryDb(seed);
  const deps: Deps = {
    db,
    requireUser: (ctx) => { if (!ctx.user) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); return ctx.user; },
    qca: createFakeQca(),
    config: { cloudApiOrigin: 'https://api.qoder.com.cn', appScope: 'guidy-test', modelId: 'model-fake' },
  };
  return { db, app: application(deps) };
}
function req(method: string, path: string, body?: unknown, user: { id: string } | null = { id: 'visitor-a' }): RouteCtx {
  return {
    request: new Request(`http://127.0.0.1:8000/functions/v1/app${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    user,
  };
}
function fullSeed() {
  return {
    plans: [
      { id: 'p1', owner_visitor_id: 'visitor-a', title: '我的计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
      { id: 'p2', owner_visitor_id: 'visitor-x', title: '第三方', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
    ],
    blocks: [{ id: 'b1', plan_id: 'p1', title: '块', start_utc: '2026-11-16T01:00:00Z', end_utc: '2026-11-16T02:00:00Z' }],
    task_defs: [{ id: 't1', plan_id: 'p1', key: 'k', title: '任务', category: 'study', duration_min: 60, frequency: { type: 'daily' } }],
    constraints: [{ id: 'k1', plan_id: 'p1', type: 'active_window', start: '07:00', end: '23:00' }],
    conversations: [{ id: 'cv1', owner_visitor_id: 'visitor-a', plan_id: 'p1', qca_session_id: 's1', last_seq: 0, last_event_id: null }],
    messages: [{ id: 'm1', conversation_id: 'cv1', seq: 1, role: 'user', text: '你好' }],
    dispatch_intents: [{ request_id: 'r1', visitor_id: 'visitor-a', status: 'completed' }],
    commit_log: [{ preview_id: 'pv1', visitor_id: 'visitor-a', plan_id: 'p1' }],
    quotas: [{ visitor_id: 'visitor-a', day: '2026-11-16', chat_turns: 5, publishes: 0, recovery_attempts: 0 }],
    recovery_codes: [{ id: 'rc1', visitor_id: 'visitor-a', code_hash: 'h1', used_at: null, claimed_by: null, overwritten_at: null, created_at: '2026-11-16T00:00:00Z' }],
  };
}

describe('POST /api/data/delete-all', () => {
  it('正确 token → 200 + 各表计数，全表清空（含 recovery_codes），第三方零影响', async () => {
    const { db, app } = setup(fullSeed());
    const res = await app(req('POST', '/api/data/delete-all', { confirm_token: 'DELETE' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toEqual({
      messages: 1, dispatch_intents: 1, blocks: 1, task_defs: 1, constraints: 1,
      commit_log: 1, conversations: 1, plans: 1, quotas: 1, recovery_codes: 1,
    });
    expect(db.tables.plans.map((p) => p.id)).toEqual(['p2']);
    expect(db.tables.messages).toHaveLength(0);
    expect(db.tables.conversations).toHaveLength(0);
    expect(db.tables.quotas).toHaveLength(0);
    expect(db.tables.recovery_codes).toHaveLength(0);
    expect(db.tables.blocks).toHaveLength(0);
    expect(db.tables.task_defs).toHaveLength(0);
    expect(db.tables.constraints).toHaveLength(0);
    expect(db.tables.dispatch_intents).toHaveLength(0);
    expect(db.tables.commit_log).toHaveLength(0);
    const me = await (await app(req('GET', '/api/me'))).json();
    expect(me.has_recovery_code).toBe(false);
  });
  it('错 token / 缺 token → 422 validation_failed，数据不动', async () => {
    const { db, app } = setup(fullSeed());
    const wrong = await app(req('POST', '/api/data/delete-all', { confirm_token: 'delete' }));
    expect(wrong.status).toBe(422);
    expect((await wrong.json()).error.code).toBe('validation_failed');
    const missing = await app(req('POST', '/api/data/delete-all', {}));
    expect(missing.status).toBe(422);
    expect(db.tables.plans).toHaveLength(2);
  });
  it('pending 派发 → 409 dispatch_busy，数据不动', async () => {
    const { db, app } = setup({ ...fullSeed(), dispatch_intents: [{ request_id: 'r1', visitor_id: 'visitor-a', status: 'pending' }] });
    const res = await app(req('POST', '/api/data/delete-all', { confirm_token: 'DELETE' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('dispatch_busy');
    expect(db.tables.plans).toHaveLength(2);
  });
  it('空数据访客 → 200 计数全 0', async () => {
    const { app } = setup();
    const res = await app(req('POST', '/api/data/delete-all', { confirm_token: 'DELETE' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Object.values(body.deleted).every((n) => n === 0)).toBe(true);
  });
  it('无身份 → 401', async () => {
    const { app } = setup();
    const res = await app(req('POST', '/api/data/delete-all', { confirm_token: 'DELETE' }, null));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run functions/__tests__/data.test.ts`
Expected: FAIL — 路由未注册返回 404 `not_found`（expect 200/422/409 失败）。

- [ ] **Step 3: 实现**

3a. Create `functions/routes/data.ts`:

```ts
import { z } from 'npm:zod@3.25.76';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { requireVisitor } from '../identity.ts';
import { assertNoPendingDispatch } from '../quotas.ts';
import { deleteVisitorData } from '../ownership.ts';
import type { Deps, RouteCtx } from '../types.ts';

const DeleteSchema = z.object({ confirm_token: z.literal('DELETE') });

export async function deleteAll(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 4096);
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  await assertNoPendingDispatch(deps.db, visitor);
  const deleted = await deleteVisitorData(deps.db, visitor);
  return Response.json({ ok: true, deleted });
}
```

3b. Modify `functions/app.ts` — import 区追加：

```ts
import { deleteAll } from './routes/data.ts';
```

routes 数组 claim 行之后追加：

```ts
    { method: 'POST', pattern: /^\/api\/data\/delete-all$/, handler: deleteAll },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run functions/__tests__/data.test.ts`
Expected: PASS（5 tests）。

- [ ] **Step 5: 全量门禁**

Run: `npx vitest run` → 全绿（249 tests / 31 files）。
Run: `npm run check:function` → 无错误。
Run: `npm run build` → 成功。

- [ ] **Step 6: Commit**

```bash
git add functions/routes/data.ts functions/app.ts functions/__tests__/data.test.ts
git commit -m "feat(recovery): delete-all route"
```

---

### Task 7: 前端 api 客户端 + useRecovery 钩子

**Files:**
- Modify: `lib/api.ts`（me 类型补字段 + 三个新方法）
- Create: `lib/useRecovery.ts`

**Interfaces:**
- Consumes: T4–T6 路由契约（`{code}` / `{ok,plans_count,conversations_count}` / `{ok,deleted}`）；`requestJson/ApiError`（本文件）；`clearPersisted`（`lib/storage.ts`，清 `guidy.plan.v1`）。
- Produces: `api.recoveryGenerate(): Promise<{ code: string }>`；`api.recoveryClaim(code: string): Promise<{ ok: boolean; plans_count: number; conversations_count: number }>`（body 固定 `strategy:'overwrite'`）；`api.deleteAll(): Promise<{ ok: boolean; deleted: Record<string, number> }>`（body 固定 `confirm_token:'DELETE'`）；`api.me()` 类型含 `has_recovery_code: boolean`；`useRecovery()` 返回 `{ generate, generatedCode, clearCode, isGenerating, claim, isClaiming, deleteAll, isDeleting }`。T8 消费。

**测试说明（spec §5 豁免）**：vitest node 环境无 jsdom，钩子不做单测；请求契约已由 T4–T6 路由测试锁定，本任务验证 = 全量门禁（tsc 接线）+ T8 浏览器实测。这是 spec 明定的前端验证路径，不是跳过 TDD。

- [ ] **Step 1: 修改 lib/api.ts**

`api.me` 行替换为：

```ts
  me: () => requestJson<{ visitor_id: string; quotas: { chat_remaining: number; publish_remaining: number }; has_recovery_code: boolean }>('/me'),
```

`api` 对象 `interrupt` 行之后追加：

```ts
  recoveryGenerate: () => requestJson<{ code: string }>('/recovery/generate', { method: 'POST' }),
  recoveryClaim: (code: string) => requestJson<{ ok: boolean; plans_count: number; conversations_count: number }>('/recovery/claim', { method: 'POST', body: { code, strategy: 'overwrite' } }),
  deleteAll: () => requestJson<{ ok: boolean; deleted: Record<string, number> }>('/data/delete-all', { method: 'POST', body: { confirm_token: 'DELETE' } }),
```

注意：generate 无请求体（handler 不 readJson），`requestJson` 无 body 时不发 content-type，正确。

- [ ] **Step 2: 创建 lib/useRecovery.ts**

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { clearPersisted } from '@/lib/storage';

function toastError(err: unknown, fallback: string) {
  const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, fallback);
  toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
}

function resetLocal() {
  clearPersisted();
  window.location.reload();
}

export function useRecovery() {
  const qc = useQueryClient();
  const generate = useMutation({
    mutationFn: () => api.recoveryGenerate(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['me'] }); },
    onError: (err) => toastError(err, '生成恢复码失败，请重试'),
  });
  const claim = useMutation({
    mutationFn: (code: string) => api.recoveryClaim(code),
    onSuccess: () => resetLocal(),
    onError: (err) => toastError(err, '认领失败，请重试'),
  });
  const deleteAll = useMutation({
    mutationFn: () => api.deleteAll(),
    onSuccess: () => resetLocal(),
    onError: (err) => toastError(err, '删除失败，请重试'),
  });
  return {
    generate: () => generate.mutate(),
    generatedCode: generate.data?.code ?? null,
    clearCode: () => generate.reset(),
    isGenerating: generate.isPending,
    claim: (code: string) => claim.mutate(code),
    isClaiming: claim.isPending,
    deleteAll: () => deleteAll.mutate(),
    isDeleting: deleteAll.isPending,
  };
}
```

说明：claim/deleteAll 成功即 reload（服务端真相整体变更，干净重置全部 store/查询），不加成功 toast（reload 会立即冲掉它）；`clearCode` 供 T8 关抽屉时清掉一次性展示的码。

- [ ] **Step 3: 全量门禁**

Run: `npx vitest run` → 全绿（249 tests / 31 files，无新增）。
Run: `npm run check:function` → 无错误。
Run: `npm run build` → 成功（tsc --noEmit 验证 api/useRecovery 类型接线）。

- [ ] **Step 4: Commit**

```bash
git add lib/api.ts lib/useRecovery.ts
git commit -m "feat(web): recovery api client + useRecovery hook"
```

---

### Task 8: SettingsDrawer 身份与数据节 + 隐私页脚 + 浏览器实测

**Files:**
- Modify: `components/workbench/SettingsDrawer.tsx`（新节 + 移除本地清空/M1 过时文案）
- Create: `components/brand/PrivacyFooter.tsx`
- Modify: `src/App.tsx`（渲染页脚）
- Modify: `dev/function-local.ts`（dev-only fixture：cookie 切换访客，供浏览器模拟双设备）

**Interfaces:**
- Consumes: T7 `useRecovery()` 全部返回字段 + `api.me`；`useChatStore.streaming`；`useUiStore.openDrawer('settings')`；现有 `exportJson`（当前计划 JSON 导出）。
- Produces: 用户可见的生成/认领/删除 UI 与隐私页脚；dev fixture 支持 `dev_visitor` cookie（缺省 `local-visitor`）。

**裁决（执行时记入 ledger）**：旧「清空所有数据」按钮只清本机 localStorage，云端数据仍在——M2 后语义误导，且与新「删除我的全部数据」并列会造成两个 destructive 按钮混淆。以服务端 delete-all 取代它（export/import 保留）；同时删除 line 195 的 M1 过时隐私文案（「数据仅保存在本机…不会上传」已不实）。spec §2 将 SettingsDrawer 列为修改文件，此替换与其「删除我的全部数据」入口一致。dev fixture 改动仅限 `dev/`（非生产身份链路），使浏览器能验证跨设备认领黄金路径。

- [ ] **Step 1: 重写 SettingsDrawer.tsx**

完整替换 `components/workbench/SettingsDrawer.tsx` 为：

```tsx
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Download, KeyRound, Moon, Settings2, ShieldCheck, Sun, Trash2, Upload } from 'lucide-react';
import { ConstraintSchema, TaskDefSchema } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';
import { api } from '@/lib/api';
import { useRecovery } from '@/lib/useRecovery';
import { usePlanStore } from '@/store/usePlanStore';
import { useChatStore } from '@/store/useChatStore';
import { useUiStore } from '@/store/useUiStore';
import { DEFAULT_PREFS, applyPrefs, loadPrefs, savePrefs, type GuidyPrefs } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';

const HOURS = Array.from({ length: 25 }, (_, i) => i);

export function SettingsDrawer() {
  const open = useUiStore((s) => s.drawer === 'settings');
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const visibleStart = useUiStore((s) => s.visibleStart);
  const visibleEnd = useUiStore((s) => s.visibleEnd);
  const setVisibleRange = useUiStore((s) => s.setVisibleRange);
  const state = usePlanStore((s) => s.state);
  const importState = usePlanStore((s) => s.importState);
  const streaming = useChatStore((s) => s.streaming);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
  const hasCode = me.data?.has_recovery_code ?? false;
  const { generate, generatedCode, clearCode, isGenerating, claim, isClaiming, deleteAll, isDeleting } = useRecovery();
  const [claimInput, setClaimInput] = useState('');

  const [prefs, setPrefs] = useState<GuidyPrefs>(loadPrefs);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPrefs(loadPrefs());
    } else {
      clearCode();
      setClaimInput('');
    }
  }, [open]);

  const update = (patch: Partial<GuidyPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    applyPrefs(next);
    savePrefs(next);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ app: 'guidy', version: 1, state }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `guidy-${state.plan.title || 'plan'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('已导出计划 JSON');
  };

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { state?: PlanState };
      const s = parsed.state;
      if (!s?.plan?.id || !Array.isArray(s.blocks) || !Array.isArray(s.task_defs) || !Array.isArray(s.constraints)) {
        toast.error('文件格式不正确：缺少计划数据');
        return;
      }
      for (const t of s.task_defs) {
        if (!TaskDefSchema.safeParse(t).success) { toast.error('任务定义校验失败，导入已取消'); return; }
      }
      for (const c of s.constraints) {
        if (!ConstraintSchema.safeParse(c).success) { toast.error('约束校验失败，导入已取消'); return; }
      }
      for (const b of s.blocks) {
        if (!b.id || !b.title || !b.start_utc || !b.end_utc) { toast.error('任务块数据不完整，导入已取消'); return; }
      }
      importState(s);
      toast.success('计划已导入');
      closeDrawer();
    } catch {
      toast.error('无法解析 JSON 文件');
    }
  };

  const copyCode = async () => {
    if (!generatedCode) return;
    try {
      await navigator.clipboard.writeText(generatedCode);
      toast.success('恢复码已复制');
    } catch {
      toast.error('复制失败，请手动选择复制');
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) closeDrawer(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-b border-site-line px-5 py-4">
          <SheetTitle className="font-display flex items-center gap-2"><Settings2 className="h-4 w-4 text-site-brand" /> 设置</SheetTitle>
          <SheetDescription>外观调整即时生效，并保存在本机。</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 px-5 py-4">
          <section className="space-y-2">
            <Label>主题</Label>
            <div className="grid grid-cols-2 gap-2">
              {(['light', 'dark'] as const).map((t) => (
                <button
                  key={t} type="button"
                  onClick={() => setTheme(t)}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                    theme === t ? 'border-site-brand bg-site-brand/10 text-site-brand' : 'border-site-line text-site-ink-soft hover:bg-site-surface-2',
                  )}
                >
                  {t === 'light' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                  {t === 'light' ? '晨光' : '夜幕'}
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex justify-between text-sm"><Label>圆角</Label><span className="tabular text-xs text-site-ink-soft">{prefs.radius}px</span></div>
              <Slider min={4} max={16} step={1} value={[prefs.radius]} onValueChange={([v]) => update({ radius: v })} aria-label="圆角" />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-sm"><Label>间距密度</Label><span className="tabular text-xs text-site-ink-soft">{Math.round(prefs.space * 100)}%</span></div>
              <Slider min={0.85} max={1.2} step={0.05} value={[prefs.space]} onValueChange={([v]) => update({ space: v })} aria-label="间距密度" />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-sm"><Label>字号</Label><span className="tabular text-xs text-site-ink-soft">{Math.round(prefs.type * 100)}%</span></div>
              <Slider min={0.9} max={1.15} step={0.05} value={[prefs.type]} onValueChange={([v]) => update({ type: v })} aria-label="字号" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-site-line bg-site-surface px-3 py-2.5">
              <div>
                <p className="text-sm text-site-ink">动效</p>
                <p className="text-[11px] text-site-ink-soft">关闭后所有过渡与动画立即停用</p>
              </div>
              <Switch checked={prefs.motion === 1} onCheckedChange={(v) => update({ motion: v ? 1 : 0 })} aria-label="动效开关" />
            </div>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => { setPrefs(DEFAULT_PREFS); applyPrefs(DEFAULT_PREFS); savePrefs(DEFAULT_PREFS); }}>
              恢复默认外观
            </Button>
          </section>

          <Separator />

          <section className="space-y-2">
            <Label>日历显示时段</Label>
            <div className="grid grid-cols-2 gap-3">
              <NativeSelect
                value={String(visibleStart / 60)} aria-label="显示开始小时"
                onChange={(e) => {
                  const v = Number(e.target.value) * 60;
                  if (v < visibleEnd - 60) setVisibleRange(v, visibleEnd);
                }}
              >
                {HOURS.slice(0, 23).map((h) => <NativeSelectOption key={h} value={String(h)}>{String(h).padStart(2, '0')}:00 起</NativeSelectOption>)}
              </NativeSelect>
              <NativeSelect
                value={String(visibleEnd / 60)} aria-label="显示结束小时"
                onChange={(e) => {
                  const v = Number(e.target.value) * 60;
                  if (v > visibleStart + 60) setVisibleRange(visibleStart, v);
                }}
              >
                {HOURS.slice(1).map((h) => <NativeSelectOption key={h} value={String(h)}>{String(h).padStart(2, '0')}:00 止</NativeSelectOption>)}
              </NativeSelect>
            </div>
          </section>

          <Separator />

          <section className="space-y-2">
            <Label>数据</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={exportJson}><Download className="mr-1.5 h-4 w-4" /> 导出 JSON</Button>
              <Button variant="outline" onClick={() => fileRef.current?.click()}><Upload className="mr-1.5 h-4 w-4" /> 导入 JSON</Button>
            </div>
            <input
              ref={fileRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importJson(f);
                e.target.value = '';
              }}
            />
          </section>

          <Separator />

          <section className="space-y-2">
            <Label>身份与数据</Label>
            <p className="text-[11px] leading-relaxed text-site-ink-soft">
              恢复码用于跨设备或清除缓存后找回计划与对话。平台匿名身份不收集邮箱或手机号。
            </p>
            <Button variant="outline" className="w-full" disabled={isGenerating} onClick={() => generate()}>
              <KeyRound className="mr-1.5 h-4 w-4" /> {hasCode ? '重新生成恢复码（旧码立即失效）' : '生成恢复码'}
            </Button>
            {generatedCode && (
              <div className="space-y-2 rounded-lg border border-site-brand/40 bg-site-brand/5 p-3">
                <p className="break-all font-mono text-sm tracking-wider text-site-ink">{generatedCode}</p>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-site-danger">仅显示一次，请立即保存；关闭后无法再次查看</p>
                  <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={copyCode}>
                    <Copy className="mr-1 h-3.5 w-3.5" /> 复制
                  </Button>
                </div>
              </div>
            )}
            <Input
              value={claimInput} onChange={(e) => setClaimInput(e.target.value)}
              placeholder="输入恢复码（XXXX-XXXX-…）" aria-label="恢复码"
              className="font-mono text-sm"
            />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="w-full" disabled={isClaiming || streaming || !claimInput.trim()}>
                  <ShieldCheck className="mr-1.5 h-4 w-4" /> {isClaiming ? '认领中…' : '认领恢复码'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display">覆盖当前设备数据？</AlertDialogTitle>
                  <AlertDialogDescription>认领将删除当前设备的全部计划与对话，并恢复旧设备的数据，无法撤销。建议先导出 JSON 备份。</AlertDialogDescription>
                </AlertDialogHeader>
                <Button variant="outline" size="sm" onClick={exportJson}><Download className="mr-1.5 h-4 w-4" /> 导出当前计划 JSON</Button>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => claim(claimInput.trim())}>确认覆盖并认领</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="w-full text-site-danger hover:text-site-danger" disabled={isDeleting || streaming}>
                  <Trash2 className="mr-1.5 h-4 w-4" /> {isDeleting ? '删除中…' : '删除我的全部数据'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display">删除全部云端数据？</AlertDialogTitle>
                  <AlertDialogDescription>将永久删除当前身份名下的全部计划、对话与恢复码，无法撤销。建议先导出 JSON 备份。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => deleteAll()}>确认删除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

相对旧版的变化：移除 `resetAll` 选择器与本地「清空所有数据」AlertDialog、移除 M1 过时隐私文案；新增 me 查询（失败降级 `hasCode=false`）、useRecovery、claimInput state、关抽屉清码/清输入、复制、「身份与数据」节（生成/认领/删除，streaming 禁用认领与删除）。主题/外观/日历/导出导入逐字保留。

- [ ] **Step 2: 创建 PrivacyFooter.tsx**

Create `components/brand/PrivacyFooter.tsx`:

```tsx
import { useUiStore } from '@/store/useUiStore';

export function PrivacyFooter() {
  const openDrawer = useUiStore((s) => s.openDrawer);
  return (
    <footer className="shrink-0 border-t border-site-line bg-site-surface px-3 py-1.5 text-center text-[11px] leading-relaxed text-site-ink-soft">
      匿名收集：仅计划与对话内容，不收集邮箱/手机号。清缓存或换设备前请导出 JSON 或生成恢复码。
      <button type="button" className="ml-2 underline underline-offset-2 hover:text-site-ink" onClick={() => openDrawer('settings')}>
        删除我的全部数据
      </button>
    </footer>
  );
}
```

- [ ] **Step 3: App 渲染页脚**

Modify `src/App.tsx` — import 区（PlansDrawer import 之后）追加：

```tsx
import { PrivacyFooter } from '@/components/brand/PrivacyFooter';
```

在 `</nav>` 之后、`<ConstraintDrawer />` 之前追加：

```tsx
        <PrivacyFooter />
```

- [ ] **Step 4: dev fixture 支持 cookie 切换访客（dev-only）**

完整替换 `dev/function-local.ts` 为：

```ts
import { application } from '../functions/app.ts';
import { createMemoryDb } from './fake-db.ts';
import { createFakeQca, upstreamStream } from './fake-qca.ts';
const db = createMemoryDb();
const cannedSet = { type: 'constraint_set', plan_title: '本地测试计划', horizon_days: 7, task_defs: [{ key: 'math', title: '数学真题', category: 'study', duration_min: 90, frequency: { type: 'daily' } }], constraints: [{ type: 'active_window', start: '07:00', end: '23:00' }], clarifications_needed: [] };
const cannedFrames = [
  { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '```json\n' } } },
  { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '```json\n' + JSON.stringify(cannedSet) + '\n```' }] },
  { type: 'session.status', status: 'idle' },
];
const qca = createFakeQca({ openStream: async () => ({ body: upstreamStream(cannedFrames), close() {} }) });
const handle = application({ db, requireUser: (ctx) => { if (!ctx.user) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); return ctx.user; }, qca, config: { cloudApiOrigin: 'http://local', appScope: 'local-dev', modelId: 'local-fixture' } });
function visitorOf(request: Request): string {
  const m = request.headers.get('cookie')?.match(/(?:^|;\s*)dev_visitor=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : 'local-visitor';
}
console.log('Guidy local Function (FIXTURE, not real AI): http://127.0.0.1:8000');
Deno.serve({ hostname: '127.0.0.1', port: 8000 }, (request) => handle({ request, user: { id: visitorOf(request) }, requestId: crypto.randomUUID() }));
```

- [ ] **Step 5: 全量门禁**

Run: `npx vitest run` → 全绿（249 tests / 31 files）。
Run: `npm run check:function` → 无错误。
Run: `npm run build` → 成功。

- [ ] **Step 6: 浏览器实测（本地 fixture，非 live 验收）**

启动（两个后台终端）：
```bash
npm run dev:function
npm run dev
```
浏览器打开 `http://127.0.0.1:5173`，逐项验证并截图记录：

1. 页脚可见：隐私文案 + 「删除我的全部数据」入口；点击入口 → 设置抽屉打开。
2. 造一份数据（供认领恢复验证）：对话发送「帮我安排每天数学真题90分钟」→ fixture 返回约束卡 → 确认 → 生成预览 → 保存计划（M2 既有流程）。
3. 设置 → 身份与数据 → 「生成恢复码」→ 码卡片 8×4 等宽展示 + 「仅显示一次」警示；点复制 → toast「恢复码已复制」。记下码值。
4. 关抽屉再开 → 码卡片消失（一次性展示）；按钮文案变「重新生成恢复码（旧码立即失效）」（me.has_recovery_code=true）。
5. 自认领统一无效：输入刚记下的码 → 认领 → 覆盖确认 AlertDialog（含导出按钮）→ 确认 → toast「恢复码无效或已被使用」（自认领 404，码未消费）。
6. 跨设备黄金路径：执行 `document.cookie = 'dev_visitor=device-b; path=/'` → 刷新 → 空工作台（新匿名身份）；设置 → 输入设备 A 的码 → 认领 → 确认覆盖 → 页面 reload → 计划抽屉可见「本地测试计划」，对话恢复。
7. 删除全部数据（此时 device-b 拥有数据）：设置 → 「删除我的全部数据」→ AlertDialog → 确认 → reload → 空工作台；生成按钮文案回到「生成恢复码」（has_recovery_code=false）。
8. 切回 `document.cookie = 'local-visitor; path=/'` → 刷新 → 设备 A 名下为空（数据已转移并被删除，固有语义）。
9. 控制台无新增报错（list_console_messages）。

若 fixture 对话流在第 2 步卡住：记录现象，改用空数据验证认领成功路径（200+reload），转移正确性已由 T5 后端测试覆盖；不得以 mock 冒充 live 验收。

- [ ] **Step 7: 停止 dev 进程并 Commit**

```bash
git add components/workbench/SettingsDrawer.tsx components/brand/PrivacyFooter.tsx src/App.tsx dev/function-local.ts
git commit -m "feat(web): identity & data settings section + privacy footer"
```

---

## Self-Review 记录（计划作者内联自审）

1. **Spec 覆盖**：§1 DDL/限流/码形态/路由/级联/UI → T3/T1/T4-T6/T2/T8；§2 全部文件 → T1–T8 一一对应（fake-db 无需改：recovery_codes 已在 ID_TABLES，quotas schemaless，T3 测试验证）；§3 生成/认领 8 步/删除/前端 → T4/T5/T6/T7/T8；§4 错误语义与安全不变量 → T3 文案、T5 统一 404/限流先行/锁/标记、T2 visitor-scoped、T8 AlertDialog；§5 测试清单 → recoveryCode(5)/ownership(5)/recovery(15)/data(5) 全覆盖含两个续跑崩溃点；验收 live 需点名授权 → 不在本计划执行。
2. **占位符扫描**：无 TBD/TODO/「类似 Task N」；所有代码步含完整代码。
3. **类型一致性**：`isValidCode` T1 定义 T5 消费；`deleteVisitorData` 计数键 T2 定义与 T5/T6 断言一致；`transferOwnership` 返回 `{plans_count, conversations_count}` T2/T5/T7 一致；`useRecovery` 返回字段 T7 定义 T8 解构一致（含 clearCode）；`api.me` has_recovery_code T4 后端/T7 类型/T8 消费一致。
4. **已知偏差（裁决）**：quotas 转移按 day 先删目标再 UPDATE（spec §2 写「条件 UPDATE」）——防撞 (visitor_id,day) 唯一键，续跑必需，语义不变，T2 有专门测试；SettingsDrawer 本地清空按钮被服务端 delete-all 取代 + M1 过时文案移除——spec §2 修改范围内的一致性修正；dev fixture cookie 访客——dev-only，使浏览器可验证跨设备路径。执行时三者均记入 ledger。