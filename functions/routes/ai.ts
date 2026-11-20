// 无状态 AI 代理：上下文（计划/历史/共享块/画像）由客户端随请求携带，服务端不读不写数据库。
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { createProjector } from '../qca/project.ts';
import { parseModelText } from '../artifacts.ts';
import { PERIOD_BOUNDS } from '../shared/constants.ts';
import { localMinutes, localDay, minToHHmm } from '../shared/engine/time.ts';
import { buildUserMessage, ARTIFACT_REPAIR, type OtherPlanContext } from '../prompt.ts';
import { appFrame } from '../sse-app.ts';
import { readSSE } from '../qca/sse.mjs';
import { solve, applyPatch } from '../engine.ts';
import { trimArtifactToFit } from '../shared/engine/fit.ts';
import { formatAvailability, weeklyAvailability, type AvailabilitySource } from '../shared/engine/availability.ts';
import { findConflicts, type ConflictPlan, type PlanConflict } from '../shared/engine/conflicts.ts';
import { splitArtifactText } from '../shared/artifactText.ts';
import { ENGINE_VERSION, LIMITS } from '../shared/constants.ts';
import { constraintText } from '../../lib/describe.ts';
import type { Deps, RouteCtx, AppEvent } from '../types.ts';
import type { Block, PlanState } from '../shared/types.ts';

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' };
const DAY_MS = 86400000;
const WINDOW_TYPES = new Set(['busy_window', 'active_window', 'fixed_block']);

interface ChatContext {
  text: string;
  conversation_id: string | null;
  request_id: string;
  /** 客户端本机已用的最大 seq：续号，避免新一轮的 delta 与旧气泡同 seq 被合并。 */
  seq_base: number;
  today?: string;
  timezone?: string;
  plan: any | null;
  plans: any[];
  sharedBlocks: any[];
  habits?: string;
  learned?: string;
  history: { role: string; content: string }[];
}

function parseContext(body: any): ChatContext {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > LIMITS.messageChars) fail('validation_failed', 422);
  const today = typeof body?.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today) && !Number.isNaN(Date.parse(`${body.today}T12:00:00Z`))
    ? body.today : undefined;
  const timezone = typeof body?.timezone === 'string' && body.timezone.length <= 64 ? body.timezone : undefined;
  const arr = (v: unknown, max: number): any[] => (Array.isArray(v) ? v.slice(0, max) : []);
  const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);
  const history = arr(body?.history, 20)
    .filter((h: any) => (h?.role === 'user' || h?.role === 'assistant') && typeof h?.content === 'string')
    .map((h: any) => ({ role: h.role, content: String(h.content).slice(0, 4000) }));
  return {
    text,
    conversation_id: typeof body?.conversation_id === 'string' ? body.conversation_id : null,
    request_id: typeof body?.request_id === 'string' && body.request_id ? body.request_id : crypto.randomUUID(),
    seq_base: Math.max(0, Math.floor(Number(body?.seq_base) || 0)),
    today,
    timezone,
    plan: body?.plan && typeof body.plan === 'object' ? body.plan : null,
    plans: arr(body?.plans, 6).filter((p: any) => p && typeof p === 'object'),
    sharedBlocks: arr(body?.sharedBlocks, 60).filter((b: any) => b && typeof b.start_utc === 'string'),
    habits: str(body?.habits, 2000),
    learned: str(body?.learned, 2000),
    history,
  };
}

const horizonRange = (p: { horizon_start: string; horizon_days: number }) => {
  const start = Date.parse(`${p.horizon_start}T00:00:00Z`);
  return { start, end: start + p.horizon_days * DAY_MS };
};
const windowSummary = (constraints: any[]) =>
  constraints.filter((c) => c.enabled !== false && WINDOW_TYPES.has(c.payload?.type)).slice(0, 8)
    .map((c) => ({ id: c.id, text: constraintText(c.payload) }));

/** 客户端传来的其他计划 → prompt 上下文（与服务端 DB 版同样裁剪：块只取与活动跨度相交的）。 */
function relatedFor(ctx: ChatContext) {
  const active = ctx.plan as PlanState | null;
  if (!active?.plan?.id) {
    const others: OtherPlanContext[] = ctx.plans.filter((p) => p?.plan?.id).slice(0, 3).map((p) => ({
      id: p.plan.id, title: p.plan.title, horizon_start: p.plan.horizon_start, horizon_days: p.plan.horizon_days, timezone: p.plan.timezone,
      blocks: (p.blocks ?? []).slice(0, 12), tasks: p.task_defs ?? [], windows: windowSummary(p.constraints ?? []),
    }));
    const sources: AvailabilitySource[] = ctx.plans.filter((p) => p?.plan?.id).slice(0, 3).map((p) => ({ constraints: p.constraints ?? [], blocks: p.blocks ?? [] }));
    return { conflicts: [] as PlanConflict[], others, sources };
  }
  const activeRange = horizonRange(active.plan);
  const activeEstablished = (active.blocks?.length ?? 0) > 0 || (active.task_defs?.length ?? 0) > 0;
  const sources: AvailabilitySource[] = [{ constraints: activeEstablished ? active.constraints ?? [] : [], blocks: active.blocks ?? [] }];
  const conflictSources: ConflictPlan[] = [{ id: active.plan.id, title: active.plan.title, blocks: active.blocks ?? [] }];
  const others: OtherPlanContext[] = [];
  for (const p of ctx.plans) {
    if (!p?.plan?.id || p.plan.id === active.plan.id || others.length >= 3) continue;
    const blocks = p.blocks ?? [];
    const windows = windowSummary(p.constraints ?? []);
    sources.push({ constraints: p.constraints ?? [], blocks });
    const range = horizonRange(p.plan);
    const intersects = !(range.end <= activeRange.start || range.start >= activeRange.end);
    if (intersects && blocks.length) conflictSources.push({ id: p.plan.id, title: p.plan.title, blocks });
    const shownBlocks = intersects ? blocks : [];
    if (!shownBlocks.length && !windows.length && !(p.task_defs ?? []).length) continue;
    others.push({ id: p.plan.id, title: p.plan.title, horizon_start: p.plan.horizon_start, horizon_days: p.plan.horizon_days, timezone: p.plan.timezone, blocks: shownBlocks, tasks: p.task_defs ?? [], windows });
  }
  const conflicts = conflictSources.length > 1 ? findConflicts(conflictSources, { onlyPlanId: active.plan.id }) : [];
  return { conflicts, others, sources };
}

export async function aiChat(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const body = await readJson(ctx.request, 262144);
  const chat = parseContext(body);
  const day = chat.today ?? new Date().toISOString().slice(0, 10);
  const planState = chat.plan as PlanState | null;
  const tz = planState?.plan?.timezone ?? chat.timezone ?? 'Asia/Shanghai';
  const related = relatedFor(chat);
  const sharedBlocks = chat.sharedBlocks as Block[];
  const sources = [...related.sources, ...(sharedBlocks.length ? [{ constraints: [], blocks: sharedBlocks }] : [])];
  const availability = sources.length ? formatAvailability(weeklyAvailability(sources, tz)) : '';
  const sharedEnd = planState?.plan ? horizonRange(planState.plan).end : Date.parse(`${day}T00:00:00Z`) + 30 * DAY_MS;
  const sharedForPrompt = sharedBlocks.filter((b) => {
    const t = Date.parse(b.start_utc);
    return t >= Date.parse(`${day}T00:00:00Z`) && t < sharedEnd;
  }).slice(0, 24);

  const previewSolve = (cs: any) => {
    const sharedCons = related.sources.flatMap((s) => s.constraints).filter((c: any) => c.payload.type === 'busy_window' || c.payload.type === 'fixed_block');
    return solve({
      engine_version: ENGINE_VERSION,
      horizon_start: cs.horizon_start ?? planState?.plan.horizon_start ?? day,
      horizon_days: cs.horizon_days,
      timezone: tz,
      task_defs: cs.task_defs,
      constraints: [
        ...cs.constraints.map((p: any, i: number) => ({ id: `pre-${i}`, payload: p, source: 'ai' as const, enabled: true })),
        ...sharedCons,
      ],
      pinned_blocks: sharedBlocks.map((b) => ({ ...b, pinned: true })),
    });
  };

  const userMessage = buildUserMessage({
    message: chat.text,
    plan: planState,
    history: chat.history,
    today: chat.today,
    timezone: chat.timezone,
    conflicts: related.conflicts,
    others: related.others,
    availability,
    sharedBlocks: sharedForPrompt,
    habits: chat.habits,
    learned: chat.learned,
  });

  /** 偏好时段是否兑现：给出「任务实际落在何时、与偏好不符」的人话说明。 */
  const preferenceNotes = (plan: any, blocks: any[]): string[] => {
    const notes: string[] = [];
    for (const t of plan.task_defs ?? []) {
      if (!t.preferred_period || !PERIOD_BOUNDS[t.preferred_period]) continue;
      const mine = blocks.filter((b: any) => b.task_key === t.key);
      if (!mine.length) continue;
      const [from, to] = PERIOD_BOUNDS[t.preferred_period];
      let inside = 0;
      let total = 0;
      for (const b of mine) {
        const sMin = localMinutes(b.start_utc, tz);
        const eMin = localMinutes(b.end_utc, tz);
        total += Math.max(0, eMin - sMin);
        inside += Math.max(0, Math.min(eMin, to) - Math.max(sMin, from));
      }
      if (!total || inside / total >= 0.6) continue;
      const first = [...mine].sort((a: any, b: any) => a.start_utc.localeCompare(b.start_utc))[0];
      const when = `${localDay(first.start_utc, tz).slice(5)} ${minToHHmm(localMinutes(first.start_utc, tz))}–${minToHHmm(localMinutes(first.end_utc, tz))}`;
      notes.push(`「${t.title}」实际主要在 ${when}，与你要求的时段不符（可在方案卡里调整可安排时段后重新生成）`);
    }
    return notes;
  };

  let live = true;
  const stream = new ReadableStream<Uint8Array>({
    cancel() { live = false; },
    async start(controller) {
      let seq = Number(chat.seq_base) || 0;
      const nextSeq = () => ++seq;
      let aborter: AbortController | null = null;
      const emit = (e: AppEvent) => {
        if (!live) return;
        try { controller.enqueue(appFrame(e.data.seq, e.event, e.data)); } catch { live = false; }
      };
      const heartbeat = setInterval(() => {
        try { controller.enqueue(new TextEncoder().encode(': ping\n\n')); } catch { /* closed */ }
      }, 5000);
      try {
        emit({ event: 'accepted', data: { request_id: chat.request_id, conversation_id: chat.conversation_id ?? '', seq: nextSeq() } });
        const binding = await deps.qca.ensureBinding(deps.config.appScope);
        const session = await deps.qca.createSession(binding, chat.text.slice(0, 30), {});
        const sessionId = session.id;
        let bestText = '';
        let emittedProse = '';
        // 重试时客户端已收到上一轮文字：用 attempt 标记让它整段替换，不要在同一个气泡里叠加。
        let replacedThisAttempt = false;
        const assistantSeq = nextSeq();
        let terminalState: 'completed' | 'failed' | 'interrupted' = 'failed';
        let terminalAttempt = 0;
        let repairNote = '';
        const turnDeadline = Date.now() + (deps.config.turnBudgetMs ?? 55000);
        for (let attempt = 0; attempt < 3; attempt++) {
          terminalAttempt = attempt;
          if (attempt > 0) { emittedProse = ''; replacedThisAttempt = false; }
          const remaining = turnDeadline - Date.now();
          if (remaining < 5000) break;
          const projector = createProjector(nextSeq, assistantSeq);
          await deps.qca.sendEvents(sessionId, userMessage + (attempt > 0 ? `\n\n${ARTIFACT_REPAIR}${repairNote}` : ''), `${chat.request_id}:${attempt}`);
          aborter = new AbortController();
          // 推理模型思考阶段没有正文，适配器会持续发 thinking 帧保持活跃；仍留 25s 兜底。
          const idleMs = deps.config.attemptTimeoutMs ?? 25000;
          const totalMs = Math.min(deps.config.attemptTotalMs ?? 40000, remaining);
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => aborter?.abort(), idleMs);
          };
          const totalTimer = setTimeout(() => aborter?.abort(), totalMs);
          resetIdle();
          const upstream = await deps.qca.openStream(sessionId, { signal: aborter.signal });
          try {
            for await (const frame of readSSE(upstream.body, { signal: aborter.signal })) {
              resetIdle();
              const ev = JSON.parse(frame.data);
              for (const p of projector.push(ev)) {
                if (p.event === 'progress') { emit(p); continue; }
                if (p.event === 'delta') {
                  const prose = splitArtifactText(projector.text()).prose;
                  const tick = prose.lastIndexOf('`');
                  const brace = prose.lastIndexOf('{');
                  const cut = Math.min(tick < 0 ? prose.length : tick, brace < 0 ? prose.length : brace);
                  const safe = prose.slice(0, cut);
                  if (safe.length > emittedProse.length) {
                    const replace = attempt > 0 && !replacedThisAttempt;
                    const text = replace ? safe : safe.slice(emittedProse.length);
                    replacedThisAttempt = true;
                    emittedProse = safe;
                    emit({ event: 'delta', data: { seq: p.data.seq, text, attempt } as any });
                  }
                  continue;
                }
                emit(p);
                if (p.event === 'status') terminalState = p.data.state === 'completed' ? 'completed' : 'failed';
                if (p.event === 'error') terminalState = 'failed';
              }
              if (projector.isTerminal()) break;
            }
          } catch {
            if (attempt < 2) {
              if (terminalState !== 'completed') repairNote = '\n上一轮输出超时或被截断。本轮请精简：JSON 单行紧凑、task_defs ≤4、constraints ≤6、省略 notes。';
              continue;
            }
          } finally {
            if (idleTimer) clearTimeout(idleTimer);
            clearTimeout(totalTimer);
            upstream.close();
          }
          const finalText = projector.text();
          if (finalText.length > bestText.length) bestText = finalText;
          if (!projector.isTerminal()) terminalState = 'failed';
          if (!finalText.trim()) {
            if (attempt < 2 && turnDeadline - Date.now() > 8000) { repairNote = '\n上一轮没有任何输出。不要调用工具，直接给出答案或 JSON 产物。'; continue; }
            terminalState = 'failed';
            emit({ event: 'error', data: { seq: nextSeq(), code: 'empty_response', message: 'AI 没有返回内容，请重试', diagnostic_id: crypto.randomUUID() } });
            break;
          }
          const parsed = parseModelText(finalText, day);
          if (parsed) {
            let preview: unknown;
            if (parsed.kind === 'constraint_set') {
              const out = previewSolve(parsed.value);
              if (out.violations.length && attempt < 2) {
                repairNote = `
预排程不可行：${out.violations.map((v: any) => v.reason).join('；')}。请只保留用户明确提到的任务、缩短单次时长或减少次数后重新输出完整 constraint_set。`;
                continue;
              }
              const base: any = { feasibility: out.feasibility, unplaced: out.unplaced, violations: out.violations, compromises: out.compromises };
              if (out.violations.length) {
                const trimmed = trimArtifactToFit(parsed.value, { horizon_start: parsed.value.horizon_start ?? day, timezone: tz }, sharedBlocks.map((b) => ({ ...b, pinned: true })));
                if (trimmed) base.proposal = { changes: trimmed.changes, suggested: { ...trimmed.draft, clarifications_needed: [...trimmed.draft.clarifications_needed ?? [], `容量不足，可接受的取舍：${trimmed.changes.join('；')}。`] } };
              }
              preview = base;
            } else if (parsed.kind === 'patch' && planState?.plan?.id) {
              const applied = applyPatch(planState as any, parsed.value.ops as any);
              if (applied.missing.length && attempt < 2) {
                repairNote = `
调整目标已不存在：${applied.missing.slice(0, 5).join('、')}。请基于当前计划重新输出 patch，不要臆造 id/key。`;
                continue;
              }
              const pinned = applied.state.blocks.filter((b: any) => b.pinned || b.origin === 'manual' || ['completed', 'in_progress', 'partial'].includes(String(b.status ?? '')));
              const out = solve({
                engine_version: ENGINE_VERSION,
                horizon_start: planState.plan.horizon_start,
                horizon_days: planState.plan.horizon_days,
                timezone: tz,
                task_defs: applied.state.task_defs,
                constraints: applied.state.constraints,
                pinned_blocks: [...pinned, ...sharedBlocks.map((b) => ({ ...b, pinned: true }))],
              });
              if (out.violations.length && attempt < 2) {
                repairNote = `
应用这条调整会排不下：${out.violations.map((v: any) => v.reason).join('；')}。请改用更小的改动（减少次数/时长或放宽时段），保留用户已钉住的块。`;
                continue;
              }
              preview = {
                feasibility: (out as any).feasibility, unplaced: (out as any).unplaced, violations: out.violations,
                compromises: out.compromises, notes: preferenceNotes(applied.state, out.blocks),
              };
            }
            emit({ event: 'artifact', data: { seq: nextSeq(), kind: parsed.kind, payload: parsed.value, ...(preview ? { preview } : {}) } });
            terminalState = 'completed';
            break;
          }
          const expectsArtifact = /```json|^\s*\{/.test(finalText);
          if ((expectsArtifact || /(制定|做|排|列|生成|安排|规划|调整|修改|改|加|删).{0,8}(计划|方案|日程|作息|表)|直接给方案/.test(chat.text)) && attempt < 2) {
            repairNote = '\n输出被截断或只有文字。本轮必须直接输出完整闭合的 ```json 产物：task_defs ≤4、constraints ≤6、省略 notes，宁可少列也别截断。';
            continue;
          }
          if (expectsArtifact) {
            terminalState = 'failed';
            emit({ event: 'error', data: { seq: nextSeq(), code: 'artifact_invalid', message: 'AI 返回的方案不完整，请重试', diagnostic_id: crypto.randomUUID() } });
          }
          break;
        }
        const finalProse = splitArtifactText(bestText).prose;
        if (finalProse.length > emittedProse.length) {
          const replace = emittedProse === '' && finalProse.length > 0;
          emit({ event: 'delta', data: { seq: nextSeq(), text: replace ? finalProse : finalProse.slice(emittedProse.length), attempt: terminalAttempt } as any });
        }
        emit({ event: 'status', data: { seq: nextSeq(), state: terminalState } });
        emit({ event: 'done', data: { seq: nextSeq() } });
      } catch (e) {
        console.error('ai_chat_failed', String((e as any)?.message ?? e).slice(0, 200));
        emit({ event: 'error', data: { seq: nextSeq(), code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() } });
        emit({ event: 'done', data: { seq: nextSeq() } });
      } finally {
        clearInterval(heartbeat);
        aborter?.abort();
        try { controller.close(); } catch { /* closed */ }
      }
    },
  });
  return new Response(stream, { status: 202, headers: SSE_HEADERS });
}