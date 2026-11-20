// 本机业务实现：与旧服务端 routes 的行为对齐（求解/校验/忙时物化/版本），但只落在 IndexedDB。
import { ApiError } from '@/lib/apiError';
import { ENGINE_VERSION } from '@/shared/constants';
import { applyPatch, diffBlocks, resultHash, solve, validatePlacement } from '@/shared/engine';
import { dayList, hhmmToMin, localDay, localMinutes, minToHHmm, utcAt, weekdayOfDay } from '@/shared/engine/time';
import { summarizeHabit, type LocalActivity, type Profile } from '@/shared/profile';
import {
  addTombstone, appendMessage, deleteEverything, deleteShared, getConversation, getPlan, getProfile,
  getTombstones, getVisitorId, listConversations, listMessages, listPlans, listShared, nowIso, planCount,
  putConversation, putPlan, putProfile, putShared, removeConversationsForPlan, removeMessages, removePlan, setMeta, uuid,
} from './repo';
import type { ConversationRecord, MessageRecord, PlanRecord, SharedBlock } from './repo';
import type { ApplyOp, Block, Constraint, PlanState, TaskDef } from '@/shared/types';
import type { ConstraintSetArtifact } from '@/shared/schemas';

export const MATERIALIZED_NOTE = '共享日历：固定日程，与普通任务一样可拖拽/编辑/删除';
const DROPPED_AT_COMMIT = new Set(['busy_window', 'fixed_block']);
const MAX_DAYS = 92;

const stateOf = (p: PlanRecord): PlanState => ({ plan: p, task_defs: p.task_defs, constraints: p.constraints, blocks: p.blocks });

/** 忙时/固定日程已物化成共享块，计划自身不再持有这些约束；历史数据读取时同样剥掉。 */
export const visibleConstraints = (constraints: Constraint[]): Constraint[] =>
  constraints.filter((c) => !DROPPED_AT_COMMIT.has(String(c.payload?.type)));

export async function localPlans(): Promise<{ items: PlanRecord[] }> {
  const items = (await listPlans()).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return { items };
}

export async function localPlan(id: string): Promise<PlanState> {
  const p = await getPlan(id);
  if (!p) throw new ApiError('not_found', 404, '计划不存在');
  await materializeShared();
  const fresh = (await getPlan(id)) ?? p;
  const sharedIds = new Set((await listShared()).map((b) => b.id));
  return stateOf({
    ...fresh,
    constraints: visibleConstraints(fresh.constraints),
    // 旧版本曾把共享块求解结果写回计划：读取时直接剥掉，避免与公共日历重复渲染。
    blocks: fresh.blocks.filter((b) => !sharedIds.has(b.id)),
  });
}

function tombstoneKey(parts: string[]): string {
  return parts.map((part) => {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(part)) return part;
    const ms = Date.parse(part);
    return Number.isNaN(ms) ? part : new Date(ms).toISOString();
  }).join('|');
}

/** 把计划里的忙时/固定日程物化成共享日历块，并从计划约束里移除（服务端同款行为）。 */
export async function materializeShared(): Promise<void> {
  const plans = await listPlans();
  const valid = plans.filter((p) => p.horizon_start && p.horizon_days > 0);
  if (!valid.length) return;
  const start = valid.map((p) => p.horizon_start).sort()[0];
  const endMs = Math.max(...valid.map((p) => Date.parse(`${p.horizon_start}T00:00:00Z`) + p.horizon_days * 86400000));
  const tz = valid[0].timezone ?? 'Asia/Shanghai';
  const days = Math.min(MAX_DAYS, Math.max(1, Math.round((endMs - Date.parse(`${start}T00:00:00Z`)) / 86400000)));
  const tombstones = new Set((await getTombstones()).flatMap((k) => [k, tombstoneKey(k.split('|'))]));
  const recurring: any[] = [];
  for (const p of plans) for (const c of p.constraints) if (c.enabled !== false && c.payload?.type === 'busy_window') recurring.push(c.payload);
  if (recurring.length) {
    const existing = await listShared();
    const seen = new Set(existing.map((b) => `${b.title}|${b.start_utc}`));
    const overlaps = (s: string, e: string) => existing.some((b) => Math.min(Date.parse(b.end_utc), Date.parse(e)) - Math.max(Date.parse(b.start_utc), Date.parse(s)) > 0);
    for (const day of dayList(start, Math.min(days, MAX_DAYS), tz)) {
      const wd = weekdayOfDay(day, tz);
      for (const payload of recurring) {
        if (!(payload.date !== undefined ? payload.date === day : payload.weekday === wd)) continue;
        const title = String(payload.label ?? payload.title ?? '忙碌').slice(0, 60);
        const startUtc = utcAt(day, hhmmToMin(payload.start), tz);
        const endUtc = utcAt(day, hhmmToMin(payload.end), tz);
        const key = `${title}|${startUtc}`;
        const windowKey = `${startUtc}|${endUtc}`;
        if (tombstones.has(key) || tombstones.has(windowKey) || seen.has(key) || overlaps(startUtc, endUtc)) continue;
        const block: SharedBlock = {
          id: uuid(), title, category: payload.category ?? 'work', start_utc: startUtc, end_utc: endUtc,
          priority: 'high', pinned: false, origin: 'manual', notes: MATERIALIZED_NOTE,
        };
        seen.add(key);
        existing.push(block);
        await putShared(block);
      }
    }
  }
  for (const p of plans) {
    const kept = p.constraints.filter((c) => !DROPPED_AT_COMMIT.has(String(c.payload?.type)));
    if (kept.length !== p.constraints.length) await putPlan({ ...p, constraints: kept });
  }
}

export async function localCalendar(): Promise<{ blocks: SharedBlock[] }> {
  await materializeShared();
  return { blocks: await listShared() };
}

/** 落库后立刻物化忙时；返回物化后的记录（busy/fixed 约束已移除），与旧服务端响应一致。 */
async function savePlanRecord(rec: PlanRecord): Promise<PlanRecord> {
  await putPlan(rec);
  await materializeShared();
  return (await getPlan(rec.id)) ?? rec;
}

export async function localCommit(body: any): Promise<any> {
  if (Number(body?.engine_version) !== ENGINE_VERSION) throw new ApiError('engine_version_mismatch', 409, '排程引擎版本不一致');
  const input = body?.input;
  if (!input || !Array.isArray(input.task_defs) || !input.task_defs.length) throw new ApiError('validation_failed', 422, '至少需要一个任务');
  const shared = await listShared();
  const solved = solve({
    engine_version: ENGINE_VERSION,
    horizon_start: input.horizon_start,
    horizon_days: input.horizon_days,
    timezone: input.timezone,
    task_defs: input.task_defs as TaskDef[],
    constraints: (input.constraints ?? []).map((c: Constraint) => ({ ...c })),
    pinned_blocks: shared.map((b) => ({ ...b, pinned: true })),
  });
  if (solved.violations.length) throw new ApiError('engine_infeasible', 422, `当前约束下排不下全部任务：${solved.violations[0]?.reason ?? '无可安排时段'}`, undefined, { violations: solved.violations, compromises: solved.compromises });
  const busyIds = new Set(shared.map((b) => b.id));
  const freshBlocks = solved.blocks.filter((b) => !busyIds.has(b.id));
  const existing = body.plan_id ? await getPlan(String(body.plan_id)) : undefined;
  if (body.plan_id && !existing) throw new ApiError('not_found', 404, '计划不存在');
  const now = nowIso();
  const rec: PlanRecord = {
    id: existing?.id ?? uuid(),
    title: String(input.title).slice(0, 60),
    horizon_start: input.horizon_start,
    horizon_days: input.horizon_days,
    timezone: input.timezone,
    status: 'active',
    version: (existing?.version ?? 0) + 1,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    task_defs: input.task_defs,
    constraints: input.constraints ?? [],
    blocks: freshBlocks,
  };
  const stored = await savePlanRecord(rec);
  if (body.conversation_id) {
    const conv = await getConversation(String(body.conversation_id));
    if (conv && !conv.plan_id) await putConversation({ ...conv, plan_id: stored.id, updated_at: now });
  }
  return { plan: stored, version: stored.version, task_defs: stored.task_defs, constraints: stored.constraints, blocks: stored.blocks, server_authoritative: false };
}

export async function localSaveDraft(body: any): Promise<any> {
  const input = body?.input;
  if (!input) throw new ApiError('validation_failed', 422, '缺少计划内容');
  const sharedIds = new Set((await listShared()).map((b) => b.id));
  const existing = body.plan_id ? await getPlan(String(body.plan_id)) : undefined;
  if (body.plan_id && !existing) throw new ApiError('not_found', 404, '计划不存在');
  const now = nowIso();
  const rec: PlanRecord = {
    id: existing?.id ?? uuid(),
    title: String(input.title ?? existing?.title ?? '计划').slice(0, 60),
    horizon_start: input.horizon_start,
    horizon_days: input.horizon_days,
    timezone: input.timezone,
    status: existing?.status ?? 'draft',
    version: (existing?.version ?? 0) + 1,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    task_defs: input.task_defs ?? [],
    constraints: input.constraints ?? [],
    blocks: (input.blocks ?? []).filter((b: Block) => !sharedIds.has(b.id)),
  };
  const stored = await savePlanRecord(rec);
  if (body.conversation_id) {
    const conv = await getConversation(String(body.conversation_id));
    if (conv && !conv.plan_id) await putConversation({ ...conv, plan_id: stored.id, updated_at: now });
  }
  return { plan: stored, version: stored.version, task_defs: stored.task_defs, constraints: stored.constraints, blocks: stored.blocks };
}

const appliedPreviews = new Map<string, { planId: string; version: number }>();

export async function localApplyPatch(body: any): Promise<any> {
  if (Number(body?.engine_version) !== ENGINE_VERSION) throw new ApiError('engine_version_mismatch', 409, '排程引擎版本不一致');
  const planId = String(body?.plan_id ?? '');
  const rec = await getPlan(planId);
  if (!rec) throw new ApiError('not_found', 404, '计划不存在');
  const undo = !!body.undo;
  const ops = (body.ops ?? []) as ApplyOp[];
  if (!undo && ops.length > 30) throw new ApiError('validation_failed', 422, '一次最多应用 30 条调整');
  const mem = appliedPreviews.get(String(body.preview_id));
  if (mem) return { plan: rec, version: rec.version, task_defs: rec.task_defs, constraints: rec.constraints, blocks: rec.blocks, inverse_ops: [], diff: { added: [], removed: [], moved: [] }, compromises: [], server_authoritative: false };
  if (Number(rec.version) !== Number(body.base_version)) {
    throw new ApiError('version_conflict', 409, '计划已在其他地方更新', undefined, { plan: rec, task_defs: rec.task_defs, constraints: rec.constraints, blocks: rec.blocks });
  }
  // 与服务端 loadState 一致：忙时/固定日程只以共享块参与，不再出现在计划约束里。
  const sharedBefore = await listShared();
  const sharedIdsBefore = new Set(sharedBefore.map((b) => b.id));
  const baseBlocks = rec.blocks.filter((b) => !sharedIdsBefore.has(b.id));
  const state: PlanState = { ...stateOf(rec), constraints: visibleConstraints(rec.constraints), blocks: baseBlocks };
  const patched = applyPatch(state, ops);
  if (patched.missing.length) throw new ApiError('patch_target_missing', 422, '调整目标已不存在', undefined, { targets: patched.missing });
  const shared = await listShared();
  const pctx = {
    timezone: rec.timezone, horizon_start: rec.horizon_start, horizon_days: rec.horizon_days,
    blocks: patched.state.blocks, constraints: patched.state.constraints,
  };
  for (const op of ops) {
    let id: string | null = null;
    if (op.op === 'add_block') id = (op as any).client_id ?? null;
    else if (op.op === 'move_block' || op.op === 'update_block') id = (op as any).id;
    if (!id) continue;
    const b = patched.state.blocks.find((x) => x.id === id);
    if (!b) continue;
    const check = validatePlacement({ id: b.id, task_key: b.task_key, title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc }, pctx);
    if (!check.ok) throw new ApiError('placement_invalid', 422, check.hard?.reason ?? '时间块位置不合法');
  }
  const explicitReschedule = ops.some((op) => op.op === 'reschedule');
  const explicitLayout = ops.some((op) => op.op === 'add_block' || op.op === 'remove_block');
  const shouldReschedule = patched.requiresReschedule && (state.blocks.length > 0 || explicitReschedule) && !explicitLayout;
  let blocks = patched.state.blocks;
  let compromises: any[] = [];
  if (shouldReschedule) {
    const pinned = [
      ...patched.state.blocks.filter((b) => b.pinned || b.origin === 'manual' || ['completed', 'in_progress', 'partial'].includes(String(b.status ?? ''))),
      ...shared.map((b) => ({ ...b, pinned: true })),
    ];
    const out = solve({
      engine_version: ENGINE_VERSION,
      horizon_start: rec.horizon_start,
      horizon_days: rec.horizon_days,
      timezone: rec.timezone,
      task_defs: patched.state.task_defs,
      constraints: patched.state.constraints,
      pinned_blocks: pinned,
    });
    if (out.violations.length) throw new ApiError('engine_infeasible', 422, `当前约束下排不下全部任务：${out.violations[0]?.reason ?? '无可安排时段'}`, undefined, { violations: out.violations, compromises: out.compromises });
    const sharedIds = new Set(shared.map((b) => b.id));
    const inert = patched.state.blocks.filter((b) => b.status === 'cancelled' || b.status === 'skipped');
    blocks = [...out.blocks.filter((b) => !sharedIds.has(b.id)), ...inert];
    compromises = out.compromises;
  }
  const now = nowIso();
  const next: PlanRecord = {
    ...rec,
    version: rec.version + 1,
    updated_at: now,
    task_defs: patched.state.task_defs,
    constraints: patched.state.constraints,
    blocks,
  };
  const stored = await savePlanRecord(next);
  appliedPreviews.set(String(body.preview_id), { planId, version: stored.version });
  const diff = diffBlocks(state.blocks, stored.blocks);
  return {
    plan: stored, version: stored.version, task_defs: stored.task_defs, constraints: stored.constraints, blocks: stored.blocks,
    inverse_ops: patched.inverse_ops ?? [], diff, compromises, server_authoritative: false,
  };
}

export async function localDeletePlan(id: string): Promise<{ ok: boolean }> {
  const rec = await getPlan(id);
  if (!rec) throw new ApiError('not_found', 404, '计划不存在');
  await removePlan(id);
  await removeConversationsForPlan(id);
  if ((await planCount()) === 0) {
    for (const b of await listShared()) if (b.notes === MATERIALIZED_NOTE) await deleteShared(b.id);
  }
  return { ok: true };
}

export async function localSharedOps(body: any): Promise<any> {
  const ops = (body?.ops ?? []) as ApplyOp[];
  const allowed = new Set(['add_block', 'update_block', 'move_block', 'remove_block']);
  const usable = ops.filter((op) => allowed.has(op.op));
  if (!usable.length) throw new ApiError('validation_failed', 422, '公共日历只接受块的增删改移');
  let blocks = await listShared();
  for (const op of usable) {
    if (op.op === 'remove_block') {
      const target = blocks.find((b) => b.id === (op as any).id);
      if (!target) continue;
      if (target.notes === MATERIALIZED_NOTE) {
        await addTombstone(tombstoneKey([target.title, target.start_utc]));
        await addTombstone(tombstoneKey([target.start_utc, target.end_utc]));
      }
      await deleteShared(target.id);
      blocks = blocks.filter((b) => b.id !== target.id);
      continue;
    }
    if (op.op === 'add_block') {
      const v = (op as any).value;
      if (!(Date.parse(v.end_utc) > Date.parse(v.start_utc))) throw new ApiError('placement_invalid', 422, '结束时间必须晚于开始时间');
      const block: SharedBlock = {
        id: (op as any).client_id ?? uuid(), title: String(v.title ?? '').slice(0, 60), category: v.category ?? 'other',
        start_utc: v.start_utc, end_utc: v.end_utc, priority: v.priority ?? 'mid', pinned: !!v.pinned,
        origin: v.origin ?? 'manual', notes: v.notes ?? undefined,
      };
      await putShared(block);
      blocks.push(block);
      continue;
    }
    const id = (op as any).id;
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx < 0) continue;
    const patch = (op as any).patch ?? (op.op === 'move_block' ? { start_utc: (op as any).start_utc, end_utc: (op as any).end_utc } : {});
    const next = { ...blocks[idx], ...patch };
    if (!(Date.parse(next.end_utc) > Date.parse(next.start_utc))) throw new ApiError('placement_invalid', 422, '结束时间必须晚于开始时间');
    await putShared(next);
    blocks[idx] = next;
  }
  blocks = (await listShared()).sort((a, b) => a.start_utc.localeCompare(b.start_utc));
  return { blocks, inverse_ops: [] };
}

export async function localMarkProgress(blockId: string, status: string, actualDurationMin?: number | null): Promise<{ block: Block }> {
  const now = nowIso();
  const update = (b: Block): Block => {
    const next: any = { ...b, status, progress_updated_at: now };
    if (status === 'completed') next.completed_at = now;
    if (status === 'planned') { next.completed_at = null; next.actual_duration_min = null; }
    if (actualDurationMin !== undefined) next.actual_duration_min = actualDurationMin;
    return next;
  };
  for (const p of await listPlans()) {
    const idx = p.blocks.findIndex((b) => b.id === blockId);
    if (idx < 0) continue;
    const blocks = [...p.blocks];
    blocks[idx] = update(blocks[idx]);
    await putPlan({ ...p, blocks, updated_at: now });
    return { block: blocks[idx] };
  }
  const shared = await listShared();
  const sb = shared.find((b) => b.id === blockId);
  if (sb) { const next = update(sb) as SharedBlock; await putShared(next); return { block: next }; }
  throw new ApiError('not_found', 404, '时间块不存在');
}

export async function localMe(): Promise<any> {
  return { visitor_id: await getVisitorId(), quotas: { chat_remaining: 999, publish_remaining: 0 }, has_recovery_code: false };
}

export async function localConversations(): Promise<{ items: ConversationRecord[] }> {
  return { items: await listConversations() };
}

export async function localHistory(conversationId: string): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] }> {
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new ApiError('not_found', 404, '对话不存在');
  return { conversation, messages: await listMessages(conversationId) };
}

function collectActivities(blocks: { start_utc: string; end_utc: string; title: string }[], tz: string): LocalActivity[] {
  return blocks.map((b) => {
    const day = localDay(b.start_utc, tz);
    return { day, weekday: weekdayOfDay(day, tz), startMin: localMinutes(b.start_utc, tz), endMin: localMinutes(b.end_utc, tz), title: b.title };
  });
}

export async function localLearnProfile(): Promise<Profile> {
  const profile = await getProfile();
  const acts: LocalActivity[] = [];
  for (const p of await listPlans()) acts.push(...collectActivities(p.blocks, p.timezone ?? 'Asia/Shanghai'));
  acts.push(...collectActivities(await listShared(), 'Asia/Shanghai'));
  const learned = summarizeHabit(acts.slice(0, 400), new Date().toISOString().slice(0, 10));
  const now = nowIso();
  const next: Profile = { ...profile, learned, learned_at: now, updated_at: now };
  await putProfile(next);
  return next;
}

export async function localGetProfile(): Promise<Profile> { return getProfile(); }
export async function localSaveProfile(habits: string): Promise<Profile> {
  const next: Profile = { ...(await getProfile()), habits, updated_at: nowIso() };
  await putProfile(next);
  return next;
}

export async function localDeleteAll(): Promise<{ ok: boolean; deleted: Record<string, number> }> {
  const plans = await planCount();
  const convs = (await listConversations()).length;
  const shared = (await listShared()).length;
  await deleteEverything();
  await setMeta({ migrated: true, visitor_id: uuid() });
  return { ok: true, deleted: { plans, conversations: convs, shared_blocks: shared } };
}

// —— 对话本地消息 ——
export async function localEnsureConversation(id: string | null, title: string, planId: string | null): Promise<ConversationRecord> {
  if (id) {
    const conv = await getConversation(id);
    if (conv && conv.status !== 'archived') return conv;
  }
  const now = nowIso();
  const conv: ConversationRecord = { id: uuid(), title: (title || '新对话').slice(0, 30), plan_id: planId, status: 'active', created_at: now, updated_at: now };
  await putConversation(conv);
  return conv;
}
export async function localTouchConversation(id: string, planId?: string | null): Promise<void> {
  const conv = await getConversation(id);
  if (!conv) return;
  await putConversation({ ...conv, plan_id: conv.plan_id ?? planId ?? null, updated_at: nowIso() });
}
export async function localAppendMessage(m: MessageRecord): Promise<void> {
  await appendMessage(m);
  const conv = await getConversation(m.conversation_id);
  if (conv) await putConversation({ ...conv, updated_at: nowIso() });
}
export async function localRemoveMessages(conversationId: string): Promise<void> { await removeMessages(conversationId); }

// —— 一次性迁移（旧云端 → 本机） ——
export async function migrateFromCloudOnce(base: string, signal?: AbortSignal): Promise<{ migrated: boolean; source: 'cloud' | 'none' }> {
  const { getMeta } = await import('./repo');
  const meta = await getMeta();
  if (meta.migrated) return { migrated: false, source: 'none' };
  // 本地已经有数据（例如先离线用过）：不动，直接算完成。
  if ((await planCount()) > 0) { await setMeta({ migrated: true }); return { migrated: true, source: 'none' }; }
  const req = async (path: string) => {
    const res = await fetch(base + path, { credentials: 'same-origin', signal });
    if (!res.ok) throw new Error(`migrate_${res.status}`);
    return res.json();
  };
  try {
    const plansRes = await req('/plans');
    for (const item of plansRes.items ?? []) {
      const full = await req(`/plans/${encodeURIComponent(item.id)}`);
      const rec: PlanRecord = {
        id: full.plan.id, title: full.plan.title, horizon_start: full.plan.horizon_start, horizon_days: full.plan.horizon_days,
        timezone: full.plan.timezone, status: full.plan.status === 'active' ? 'active' : 'draft', version: Number(full.plan.version ?? 1),
        created_at: full.plan.created_at ?? nowIso(), updated_at: full.plan.updated_at ?? nowIso(),
        task_defs: full.task_defs ?? [], constraints: full.constraints ?? [], blocks: full.blocks ?? [],
      };
      await putPlan({ ...rec, constraints: rec.constraints.filter((c: any) => !DROPPED_AT_COMMIT.has(String(c.payload?.type))) });
    }
    const cal = await req('/calendar');
    for (const b of cal.blocks ?? []) await putShared({ ...(b as SharedBlock), notes: (b as any).notes ?? undefined });
    const convs = await req('/conversations');
    for (const c of convs.items ?? []) {
      await putConversation({ id: c.id, title: c.title, plan_id: c.plan_id ?? null, status: c.status === 'archived' ? 'archived' : 'active', created_at: c.created_at ?? nowIso(), updated_at: c.updated_at ?? nowIso() });
      const h = await req(`/chat/history?conversation_id=${encodeURIComponent(c.id)}`);
      for (const m of h.messages ?? []) {
        await appendMessage({ conversation_id: c.id, seq: m.seq, role: m.role, kind: m.kind, content: m.content, ...(m.payload !== undefined ? { payload: m.payload } : {}) });
      }
    }
    try {
      const profile = await req('/profile');
      await putProfile({ habits: profile.habits ?? '', learned: profile.learned ?? null, learned_at: profile.learned_at ?? null, updated_at: profile.updated_at ?? null });
    } catch { /* 画像可选 */ }
    await setMeta({ migrated: true });
    return { migrated: true, source: 'cloud' };
  } catch (e) {
    // 云端不可用或没有旧数据：不写 migrated，下次打开再试；本地已有数据时同样视为完成。
    return { migrated: false, source: 'none' };
  }
}