import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { incrementChatTurn, assertNoPendingDispatch, todayStr } from '../quotas.ts';
import { beginDispatch, markDispatch } from '../qca/dispatch.ts';
import { ensureConversation, getOwnedConversation, ensureQcaSession } from '../qca/sessions.ts';
import { createProjector } from '../qca/project.ts';
import { parseModelText } from '../artifacts.ts';
import { buildUserMessage, ARTIFACT_REPAIR } from '../prompt.ts';
import { appFrame, insertMessage, appendAssistant, advanceCursor, sha256Hex } from '../sse-app.ts';
import { readSSE } from '../qca/sse.mjs';
import { LIMITS, ENGINE_VERSION } from '../shared/constants.ts';
import { solve } from '../engine.ts';
import { findConflicts, type ConflictPlan, type PlanConflict } from '../shared/engine/conflicts.ts';
import { trimArtifactToFit } from '../shared/engine/fit.ts';
import { formatAvailability, weeklyAvailability, type AvailabilitySource } from '../shared/engine/availability.ts';
import { sharedBusyBlocks } from './calendar.ts';
import { decodeTaskRow, visibleBlocks, readPlanConfig } from './plans.ts';
import { ensureProfileRow, ensureLearned } from './profile.ts';
import { constraintText } from '../../lib/describe.ts';
import type { OtherPlanContext } from '../prompt.ts';
import type { Deps, RouteCtx, AppEvent } from '../types.ts';
import type { PlanState, Violation } from '../shared/types.ts';
import type { Block } from '../shared/types.ts';

export const interruptRegistry = new Map<string, AbortController>();
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' };

async function loadPlanState(db: Deps['db'], visitor: string, planId: string | null) {
  if (!planId) return null;
  const plan = rows(await db.from('plans').select('*').eq('id', planId).eq('owner_visitor_id', visitor).limit(1))[0];
  if (!plan) return null;
  const cfg = readPlanConfig(plan);
  const task_defs = cfg ? cfg.task_defs : rows(await db.from('task_defs').select('*').eq('plan_id', planId)).map(decodeTaskRow);
  const constraints = (cfg ? cfg.constraints : rows(await db.from('constraints').select('*').eq('plan_id', planId))).filter((c: any) => c.payload?.type !== 'busy_window' && c.payload?.type !== 'fixed_block');
  const blocks = visibleBlocks(plan, rows(await db.from('blocks').select('*').eq('plan_id', planId)));
  return { plan, task_defs, constraints, blocks };
}

const DAY_MS = 86400000;
function horizonRange(p: { horizon_start: string; horizon_days: number }) {
  const start = Date.parse(`${p.horizon_start}T00:00:00Z`);
  return { start, end: start + p.horizon_days * DAY_MS };
}

const WINDOW_TYPES = new Set(['busy_window', 'active_window', 'fixed_block']);

function windowSummary(constraints: any[]): { id: string; text: string }[] {
  return constraints
    .filter((c) => c.enabled !== false && WINDOW_TYPES.has(c.payload?.type))
    .slice(0, 8)
    .map((c) => ({ id: c.id, text: constraintText(c.payload) }));
}

// 新对话（草稿）没有活动计划：给一份只读的共享日历摘要，避免让用户重复说空闲时间。
async function loadSharedCalendar(db: Deps['db'], visitor: string): Promise<{ conflicts: PlanConflict[]; others: OtherPlanContext[]; sources: AvailabilitySource[] }> {
  const plans = rows(await db.from('plans').select('*').eq('owner_visitor_id', visitor).order('updated_at', { ascending: false }).limit(3));
  const out: OtherPlanContext[] = [];
  const sources: AvailabilitySource[] = [];
  for (const p of plans) {
    const blocks = visibleBlocks(p, rows(await db.from('blocks').select('*').eq('plan_id', p.id)));
    const constraints = rows(await db.from('constraints').select('*').eq('plan_id', p.id));
    const tasks = rows(await db.from('task_defs').select('*').eq('plan_id', p.id));
    if (!blocks.length && !constraints.length && !tasks.length) continue;
    sources.push({ constraints, blocks });
    out.push({ id: p.id, title: p.title, horizon_start: p.horizon_start, horizon_days: p.horizon_days, timezone: p.timezone, blocks, tasks, windows: windowSummary(constraints) });
  }
  return { conflicts: [], others: out, sources };
}
// 其他计划：块只取与活动计划 horizon 相交的（控制 token），
// 但「已有时段」（忙时/可安排）是每周重复的安排，与 horizon 无关，始终带上。
async function loadRelatedPlans(db: Deps['db'], visitor: string, active: PlanState) {
  // 只接收 loadPlanState 从库里载入的计划，id 必非空（PlanState 的 null 仅用于前端草稿）
  const activeId = active.plan.id!;
  const plans = rows(await db.from('plans').select('*').eq('owner_visitor_id', visitor).order('updated_at', { ascending: false }));
  const activeRange = horizonRange(active.plan);
  const conflictSources: ConflictPlan[] = [{ id: activeId, title: active.plan.title, blocks: active.blocks }];
  const others: OtherPlanContext[] = [];
  // 空的新计划自带的 07:00–23:00 只是默认值，不代表用户真实可用时间；
  // 有块或任务定义后它的约束才算数。
  const activeEstablished = active.blocks.length > 0 || active.task_defs.length > 0;
  const sources: AvailabilitySource[] = [{ constraints: activeEstablished ? active.constraints : [], blocks: active.blocks }];
  for (const p of plans) {
    if (p.id === activeId) continue;
    if (others.length >= 3) break;
    const blocks = visibleBlocks(p, rows(await db.from('blocks').select('*').eq('plan_id', p.id)));
    const cfgB = readPlanConfig(p);
    const constraints = cfgB ? cfgB.constraints : rows(await db.from('constraints').select('*').eq('plan_id', p.id));
    const tasks = rows(await db.from('task_defs').select('*').eq('plan_id', p.id));
    const windows = windowSummary(constraints);
    sources.push({ constraints, blocks });
    const range = horizonRange(p);
    const intersects = !(range.end <= activeRange.start || range.start >= activeRange.end);
    if (intersects && blocks.length) conflictSources.push({ id: p.id, title: p.title, blocks });
    const shownBlocks = intersects ? blocks : [];
    if (!shownBlocks.length && !windows.length && !tasks.length) continue;
    others.push({
      id: p.id,
      title: p.title,
      horizon_start: p.horizon_start,
      horizon_days: p.horizon_days,
      timezone: p.timezone,
      blocks: shownBlocks,
      tasks,
      windows,
    });
  }
  const conflicts = conflictSources.length > 1 ? findConflicts(conflictSources, { onlyPlanId: activeId }) : [];
  return { conflicts, others, sources };
}

export async function chatSend(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 8192);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > LIMITS.messageChars) fail('validation_failed', 422);
  const today = typeof body.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today) && !Number.isNaN(new Date(`${body.today}T12:00:00Z`).getTime())
    ? body.today
    : undefined;
  const timezone = typeof body.timezone === 'string' && body.timezone.length <= 64 ? body.timezone : undefined;
  const requestId = typeof body.request_id === 'string' && body.request_id ? body.request_id : crypto.randomUUID();
  let conv = await ensureConversation(deps.db, visitor, body.conversation_id ?? null, text.slice(0, 30), body.plan_id ?? null);
  // 归档对话（所属计划已删除）不再接受写入，否则会重新出现在对话列表里。
  if (conv.status === 'archived') conv = await ensureConversation(deps.db, visitor, null, text.slice(0, 30), body.plan_id ?? null);
  // 旧数据里的未绑定对话在首次续聊时补绑当前计划，之后切换/刷新/删除才能按计划归位。
  else if (conv.plan_id === null && typeof body.plan_id === 'string' && body.plan_id) {
    await deps.db.from('conversations').update({ plan_id: body.plan_id }).eq('id', conv.id).eq('owner_visitor_id', visitor);
    conv = { ...conv, plan_id: body.plan_id };
  }
  const day = todayStr(deps.now?.() ?? new Date());
  await incrementChatTurn(deps.db, visitor, day);
  await assertNoPendingDispatch(deps.db, visitor);
  const fingerprint = await sha256Hex(`${visitor}:${text}`);
  const { replay, intent } = await beginDispatch(deps.db, { request_id: requestId, visitor_id: visitor, conversation_id: conv.id, payload_fingerprint: fingerprint });
  const planState = await loadPlanState(deps.db, visitor, body.plan_id ?? null);
  const related = planState
    ? await loadRelatedPlans(deps.db, visitor, planState as PlanState)
    : await loadSharedCalendar(deps.db, visitor);
  const busyBlocks = await sharedBusyBlocks(deps.db, visitor);
  // 习惯画像：用户自述优先，日历统计仅作参考；同日懒更新，不额外调用模型。
  const profile = await ensureProfileRow(deps.db, visitor);
  const learned = await ensureLearned(deps.db, visitor, profile);
  const availabilitySources = [...related.sources, ...(busyBlocks.length ? [{ constraints: [], blocks: busyBlocks }] : [])];
  const availability = availabilitySources.length
    ? formatAvailability(weeklyAvailability(availabilitySources, planState?.plan.timezone ?? timezone ?? 'Asia/Shanghai'))
    : '';
  // 公共块是共享日历的写目标：只把计划跨度内（草稿则未来 30 天）的块列进上下文，控制 token。
  const sharedEnd = planState ? horizonRange(planState.plan).end : Date.parse(`${day}T00:00:00Z`) + 30 * DAY_MS;
  const sharedForPrompt = (busyBlocks as Block[])
    .filter((b) => {
      const t = Date.parse(b.start_utc);
      return t >= Date.parse(`${day}T00:00:00Z`) && t < sharedEnd;
    })
    .slice(0, 24);

  // 预览求解：与 commit 相同的引擎与共享占用，结果作为权威可行性数据随 artifact 下发。
  const previewSolve = (cs: any) => {
    const sharedCons = related.sources.flatMap((s) => s.constraints).filter((c: any) => c.payload.type === 'busy_window' || c.payload.type === 'fixed_block');
    return solve({
      engine_version: ENGINE_VERSION,
      horizon_start: cs.horizon_start ?? planState?.plan.horizon_start ?? day,
      horizon_days: cs.horizon_days,
      timezone: planState?.plan.timezone ?? timezone ?? 'Asia/Shanghai',
      task_defs: cs.task_defs,
      constraints: [
        ...cs.constraints.map((p: any, i: number) => ({ id: `pre-${i}`, payload: p, source: 'ai' as const, enabled: true })),
        ...sharedCons,
      ],
      pinned_blocks: busyBlocks.map((b) => ({ ...b, pinned: true })),
    });
  };

  let live = true;
  const stream = new ReadableStream<Uint8Array>({
    cancel() { live = false; },
    async start(controller) {
      // 发送序号以「库内最大 seq」为基线：失败回合可能留下孤儿行而未推进游标，
      // 若仍从 conv.last_seq 续号，重发会撞 UNIQUE(conversation_id, seq)。
      const maxRow = rows(await deps.db.from('messages').select('seq').eq('conversation_id', conv.id).order('seq', { ascending: false }).limit(1))[0];
      let seq = Math.max(conv.last_seq, maxRow?.seq ?? 0);
      const nextSeq = () => ++seq;
      // 事件游标随本回合每次开流推进；重试与失败收尾都必须从最新事件续读，而非停留在回合开始前的旧值。
      let lastEventId: string | null = conv.last_event_id;
      // 客户端断开（如切换对话）不终止规划：停止推送但继续落库，切回由 chatEvents 尾随回放。
      const emit = (e: AppEvent) => {
        if (!live) return;
        try { controller.enqueue(appFrame(e.data.seq, e.event, e.data)); } catch { live = false; }
      };
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
        let bestText = '';
        let repairNote = '';
        let pendingViolations: Violation[] = [];
        let terminalState: 'completed' | 'failed' | 'interrupted' = 'failed';
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await deps.db.from('messages').delete().eq('conversation_id', conv.id).eq('seq', assistantSeq);
          const projector = createProjector(nextSeq, assistantSeq);
          const upstream = await deps.qca.openStream(sessionId, { lastEventId: lastEventId ?? undefined, signal: abort.signal });
          try {
            await deps.qca.sendEvents(sessionId, buildUserMessage({ message: text, plan: planState, history: [], today, timezone, conflicts: related.conflicts, others: related.others, availability, sharedBlocks: sharedForPrompt, habits: profile.habits || undefined, learned: learned?.summary || undefined }) + (attempt > 0 ? `\n\n${ARTIFACT_REPAIR}${repairNote}` : ''), `${requestId}:${attempt}`);
            for await (const frame of readSSE(upstream.body, { signal: abort.signal })) {
              const ev = JSON.parse(frame.data);
              if (frame.id) lastEventId = frame.id;
              for (const p of projector.push(ev)) {
                if (p.event === 'progress') { emit(p); continue; }
                emit(p); collected.push(p);
                if (p.event === 'delta') await appendAssistant(deps.db, conv, p.data.seq, p.data.text);
                if (p.event === 'status') { terminalState = p.data.state === 'completed' ? 'completed' : 'failed'; await insertMessage(deps.db, conv, { seq: p.data.seq, role: 'system', kind: 'status', content: p.data.state }); }
                if (p.event === 'error') { terminalState = 'failed'; await insertMessage(deps.db, conv, { seq: p.data.seq, role: 'system', kind: 'error', content: p.data.code }); }
              }
              if (projector.isTerminal()) break;
            }
          } finally { upstream.close(); }
          finalText = projector.text();
          if (finalText.length > bestText.length) bestText = finalText;
          if (abort.signal.aborted) { terminalState = 'interrupted'; break; }
          if (!projector.isTerminal()) { terminalState = 'failed'; break; }
          const expectsArtifact = /```json|^\s*\{/.test(finalText);
          const parsed = parseModelText(finalText, day);
          if (parsed && parsed.kind === 'constraint_set') {
            // 预求解：不可行就把具体原因喂回修复重试，避免把排不下的方案直接当成成功。
            const pre = previewSolve(parsed.value);
            if (pre.violations.length && attempt < 2) {
              repairNote = `\n预求解发现不可行：${pre.violations.map((v) => v.reason).join('；')}。请调整次数/时长/每日上限/可安排时段后重新输出 constraint_set。`;
              continue;
            }
            pendingViolations = pre.violations;
          }
          if (parsed) {
            // 可行性以服务端 pre-solve 为准；不自动降级硬目标，只给出“可接受的取舍建议”供用户确认。
            let preview: unknown;
            if (parsed.kind === 'constraint_set') {
              const out = previewSolve(parsed.value);
              const base: any = { feasibility: out.feasibility, unplaced: out.unplaced, violations: out.violations, compromises: out.compromises };
              if (out.violations.length) {
                const meta = {
                  horizon_start: parsed.value.horizon_start ?? planState?.plan.horizon_start ?? day,
                  timezone: planState?.plan.timezone ?? timezone ?? 'Asia/Shanghai',
                };
                const trimmed = trimArtifactToFit(parsed.value, meta, busyBlocks.map((b: any) => ({ ...b, pinned: true })));
                if (trimmed) {
                  base.proposal = {
                    changes: trimmed.changes,
                    suggested: {
                      ...trimmed.draft,
                      clarifications_needed: [
                        ...(trimmed.draft.clarifications_needed ?? []),
                        `容量不足，可接受的取舍：${trimmed.changes.join('；')}。接受后会按此方案生成；不接受可自行删减任务。`,
                      ],
                    },
                  };
                }
              }
              preview = base;
            }
            const art: AppEvent = { event: 'artifact', data: { seq: nextSeq(), kind: parsed.kind, payload: parsed.value, ...(preview ? { preview } : {}) } };
            emit(art); collected.push(art);
            await insertMessage(deps.db, conv, { seq: art.data.seq, role: 'assistant', kind: parsed.kind, content: bestText || finalText, payload: parsed.value });
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
        await advanceCursor(deps.db, conv, seq, lastEventId);
        // 重试会删除上一轮的流式文本；若最终没有落任何助手内容，补存最长的那份解释，历史不再丢失。
        const hasAssistantRow = rows(await deps.db.from('messages').select('id').eq('conversation_id', conv.id).eq('seq', assistantSeq).limit(1)).length > 0;
        if (!hasAssistantRow && bestText) {
          await insertMessage(deps.db, conv, { seq: assistantSeq, role: 'assistant', kind: 'text', content: bestText });
        }
        const status: AppEvent = { event: 'status', data: { seq: nextSeq(), state: terminalState } };
        emit(status); collected.push(status);
        emit({ event: 'done', data: { seq: nextSeq() } });
        await markDispatch(deps.db, requestId, { status: terminalState === 'completed' ? 'done' : terminalState, session_id: sessionId, result: collected });
        await deps.db.from('conversations').update({ status: terminalState === 'completed' ? 'active' : terminalState }).eq('id', conv.id);
      } catch {
        const err: AppEvent = { event: 'error', data: { seq: nextSeq(), code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() } };
        emit(err);
        emit({ event: 'done', data: { seq: nextSeq() } });
        // 失败也要推进游标：否则下一回合从旧事件重放、且序号停留在孤儿行之前，导致重发再次失败。
        await advanceCursor(deps.db, conv, seq, lastEventId).catch(() => {});
        await markDispatch(deps.db, requestId, { status: 'failed' }).catch(() => {});
      } finally {
        interruptRegistry.delete(conv.id);
        try { controller.close(); } catch { /* 客户端已断开 */ }
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
  const pending = rows(await deps.db.from('dispatch_intents').select('request_id').eq('conversation_id', id).eq('status', 'pending').limit(1));
  let live = true;
  const stream = new ReadableStream<Uint8Array>({
    cancel() { live = false; },
    async start(controller) {
      let seq = conv.last_seq;
      const nextSeq = () => ++seq;
      const send = (s: number, event: string, data: unknown) => {
        if (!live) return;
        try { controller.enqueue(appFrame(s, event, data)); } catch { live = false; }
      };
      const textLen = new Map<number, number>();
      const seen = new Set<number>();
      // 增量回放 DB：规划循环在后台持续写库，这里尾随而不是再开一个上游 reader（避免重复投影）。
      const pump = async () => {
        const fresh = rows(await deps.db.from('messages').select('*').eq('conversation_id', id).order('seq', { ascending: true }).limit(500));
        for (const m of fresh) {
          if (m.seq < cursorSeq) continue;
          if (m.kind === 'text' && m.role === 'assistant') {
            const full = String(m.content);
            const from = textLen.get(m.seq) ?? (m.seq === cursorSeq ? offset : 0);
            if (full.length > from) { send(m.seq, 'delta', { seq: m.seq, text: full.slice(from) }); textLen.set(m.seq, full.length); }
          } else if (m.kind === 'constraint_set' || m.kind === 'patch' || m.kind === 'question_card') {
            if (!seen.has(m.seq)) { seen.add(m.seq); send(m.seq, 'artifact', { seq: m.seq, kind: m.kind, payload: m.payload }); }
          } else if (m.kind === 'status') {
            if (!seen.has(m.seq)) { seen.add(m.seq); send(m.seq, 'status', { seq: m.seq, state: m.content }); }
          } else if (m.kind === 'error') {
            if (!seen.has(m.seq)) { seen.add(m.seq); send(m.seq, 'error', { seq: m.seq, code: m.content, message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() }); }
          }
        }
      };
      try {
        await pump();
        if (pending.length) {
          const deadline = Date.now() + 180000;
          while (live && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 400));
            await pump();
            const still = rows(await deps.db.from('dispatch_intents').select('request_id').eq('conversation_id', id).eq('status', 'pending').limit(1));
            if (!still.length) { await pump(); break; }
          }
        }
        send(nextSeq(), 'done', { seq });
      } catch {
        send(nextSeq(), 'error', { seq, code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() });
        send(nextSeq(), 'done', { seq });
      } finally {
        try { controller.close(); } catch { /* 客户端已断开 */ }
      }
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