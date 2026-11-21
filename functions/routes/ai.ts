// 无状态 AI 代理：上下文（计划/历史/共享块/画像）由客户端随请求携带，服务端不读不写数据库。
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { createProjector } from '../qca/project.ts';
import { parseModelText } from '../artifacts.ts';
import { scheduleClaimIssues } from '../consistency.ts';
import { inheritUnavailableDates } from '../shared/engine/patch.ts';
import { PERIOD_BOUNDS } from '../shared/constants.ts';
import { localMinutes, localDay, minToHHmm } from '../shared/engine/time.ts';
import { buildUserMessage, ARTIFACT_REPAIR, type OtherPlanContext } from '../prompt.ts';
import { appFrame } from '../sse-app.ts';
import { readSSE } from '../qca/sse.mjs';
import { solve, applyPatch, hasExplicitBlockOps, changesScheduleInputs, reschedulePinnedBlocks } from '../engine.ts';
import { trimArtifactToFit } from '../shared/engine/fit.ts';
import { blockBusyCuts, type AvailabilitySource } from '../shared/engine/availability.ts';
import { findConflicts, scheduleConflicts, type ConflictPlan, type PlanConflict } from '../shared/engine/conflicts.ts';
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
      blocks: p.blocks ?? [], tasks: p.task_defs ?? [], windows: windowSummary(p.constraints ?? []),
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
  const nowMs = Date.now();
  const day = chat.today ?? new Date(nowMs).toISOString().slice(0, 10);
  const planState = chat.plan as PlanState | null;
  const tz = planState?.plan?.timezone ?? chat.timezone ?? 'Asia/Shanghai';
  const related = relatedFor(chat);
  const sharedBlocks = chat.sharedBlocks as Block[];
  // 其他计划的块以忙时裁剪参与预排程：与本地落库同一口径，跨计划不冲突、旅行等满档日按 blockedDays 跳过。
  const foreignBlocks = (chat.plans ?? [])
    .filter((p: any) => p?.plan?.id && p.plan.id !== planState?.plan?.id)
    .flatMap((p: any) => p.blocks ?? [])
    .filter((b: any) => b.status !== 'cancelled' && b.status !== 'skipped') as Block[];
  const foreignCuts = blockBusyCuts(foreignBlocks, tz);
  const availability = '';
  const sharedEnd = planState?.plan ? horizonRange(planState.plan).end : Date.parse(`${day}T00:00:00Z`) + 30 * DAY_MS;
  const sharedForPrompt = sharedBlocks.filter((b) => {
    const t = Date.parse(b.start_utc);
    return t >= Date.parse(`${day}T00:00:00Z`) && t < sharedEnd;
  });

  const previewSolve = (cs: any) => {
    const sharedCons = related.sources.flatMap((s) => s.constraints).filter((c: any) => c.payload.type === 'busy_window' || c.payload.type === 'fixed_block');
    const hs = cs.horizon_start ?? planState?.plan.horizon_start ?? day;
    return solve({
      engine_version: ENGINE_VERSION,
      now_ms: nowMs,
      horizon_start: hs,
      horizon_days: cs.horizon_days,
      timezone: tz,
      task_defs: cs.task_defs,
      constraints: [
        ...cs.constraints.map((p: any, i: number) => ({ id: `pre-${i}`, payload: p, source: 'ai' as const, enabled: true })),
        ...sharedCons,
        ...foreignCuts,
        ...blockBusyCuts(sharedBlocks, tz),
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
    now_ms: nowMs,
    conflicts: related.conflicts,
    others: related.others,
    availability,
    sharedBlocks: sharedForPrompt,
    habits: chat.habits,
    learned: chat.learned,
  });

  /** 正文对某个任务的时段承诺（任务名与「早上/下午/下班后」在同一小句内）→ 产物是否写了对应偏好。 */
  const periodOf = (word: string): string => (word === '早上' || word === '上午' ? 'morning' : word === '下午' ? 'afternoon' : 'evening');
  const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const missingClaimedPrefs = (prose: string, tasks: any[]): { title: string; period: string }[] => {
    const out: { title: string; period: string }[] = [];
    for (const t of tasks) {
      const name = escRe(String(t.title ?? ''));
      if (!name) continue;
      const after = new RegExp(`${name}[^。；\n]{0,24}?(早上|上午|下午|傍晚|晚上|下班后)`).exec(prose);
      const before = new RegExp(`(早上|上午|下午|傍晚|晚上|下班后)[^。；\n]{0,24}?${name}`).exec(prose);
      const m = after ?? before;
      if (!m) continue;
      const period = periodOf(m[1]);
      if (t.preferred_period !== period) out.push({ title: t.title, period });
    }
    return out;
  };

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

  /** 正文承诺删除/替换某个已知块 → ops 里必须有对应的 remove_block（细化=替换，不是只加不删）。 */
  const claimedRemovals = (prose: string, ops: any[], blocks: { id: string; title: string }[]): string[] => {
    if (ops.some((o) => o.op === 'clear_plan')) return [];
    const removedIds = new Set(ops.filter((o) => o.op === 'remove_block').map((o) => o.id));
    const missing = new Set<string>();
    for (const b of blocks) {
      const name = escRe(String(b.title ?? ''));
      if (!name) continue;
      const verbThenName = new RegExp(`(删除|删掉|移除|去掉|替换|撤掉|清掉|拆分|细化)[^。；！？\n]{0,24}?${name}`);
      const nameThenVerb = new RegExp(`${name}[^。；！？\n]{0,16}?(已删除|删掉|移除|替换为|拆分为|细化为|拆成|细化成)`);
      if (!verbThenName.test(prose) && !nameThenVerb.test(prose)) continue;
      if (removedIds.has(b.id)) continue;
      missing.add(b.title);
    }
    return [...missing];
  };

  /** 正文承诺挪动某个块 → 需要显式块操作，或 reschedule+规则修改；两者都没有就是空头承诺。 */
  const claimedMovesUnmet = (prose: string, ops: any[], blocks: { id: string; title: string }[]): string[] => {
    const hasLayout = ops.some((o) => o.op === 'move_block' || o.op === 'update_block');
    const hasReschedule = ops.some((o) => o.op === 'reschedule');
    const hasRuleChange = ops.some((o) => ['add_constraint', 'update_constraint', 'remove_constraint', 'add_task_def', 'update_task_def', 'remove_task_def'].includes(o.op));
    if (hasLayout || (hasReschedule && hasRuleChange)) return [];
    const missing = new Set<string>();
    for (const b of blocks) {
      const name = escRe(String(b.title ?? ''));
      if (!name) continue;
      const re = new RegExp(`${name}[^。；！？\n]{0,20}?(挪到|移到|改到|调到|放到|挪去|移去|安排在|调整到|提前到|推迟到)`);
      const rev = new RegExp(`(把|将)[^。；！？\n]{0,8}?${name}[^。；！？\n]{0,20}?(挪|移|改|调|放)`);
      if (re.test(prose) || rev.test(prose)) missing.add(b.title);
    }
    return [...missing];
  };

  /** 本次调整新引入的重叠（计划内、与公共日历、公共日历内部）：调整前已存在的重叠不算。 */
  const introducedOverlaps = (before: any[], after: any[]): { a: any; b: any }[] => {
    const iv = (b: any) => ({ s: Date.parse(b.start_utc), e: Date.parse(b.end_utc) });
    const hit = (x: any, y: any) => x.s < y.e && y.s < x.e;
    const sig = (b: any) => `${b.title}|${b.start_utc}|${b.end_utc}`;
    const pairKey = (a: any, b: any) => [sig(a), sig(b)].sort().join('~');
    const pairsOf = (world: any[]) => {
      const map = new Map<string, { a: any; b: any }>();
      for (let i = 0; i < world.length; i++) {
        for (let j = i + 1; j < world.length; j++) {
          const a = world[i]; const b = world[j];
          if (a.id && a.id === b.id) continue;
          if (!hit(iv(a), iv(b))) continue;
          const k = pairKey(a, b);
          if (!map.has(k)) map.set(k, { a, b });
        }
      }
      return map;
    };
    const preexisting = pairsOf(before);
    const fresh: { a: any; b: any }[] = [];
    for (const [k, p] of pairsOf(after)) if (!preexisting.has(k)) fresh.push(p);
    return fresh;
  };

  /** 深夜/凌晨落位统计（用户钉住或固定日程除外）：引擎已有作息保护，这里是产物级兜底。 */
  const nightBlockCount = (blocks: any[]): number =>
    blocks.filter((b: any) => !b.pinned && b.origin !== 'fixed' && (localMinutes(b.start_utc, tz) < 360 || localMinutes(b.start_utc, tz) >= 1380)).length;

  const overlapText = (p: { a: any; b: any }): string =>
    `「${p.a.title}」与「${p.b.title}」在 ${localDay(p.a.start_utc, tz).slice(5)} ${minToHHmm(Math.max(localMinutes(p.a.start_utc, tz), localMinutes(p.b.start_utc, tz)))} 起重叠`;

  let live = true;
  const stream = new ReadableStream<Uint8Array>({
    cancel() { live = false; },
    async start(controller) {
      let seq = Number(chat.seq_base) || 0;
      const nextSeq = () => ++seq;
      let aborter: AbortController | null = null;
      let errorSent = false;
      const emit = (e: AppEvent) => {
        if (!live) return;
        if (e.event === 'error') errorSent = true;
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
        // 客户端气泡当前显示的文字：终局 flush 必须复用同一气泡 seq 并整段替换，不能新 seq 再发一遍全文。
        let shownProse = '';
        // 重试时客户端已收到上一轮文字：用 attempt 标记让它整段替换，不要在同一个气泡里叠加。
        let replacedThisAttempt = false;
        const assistantSeq = nextSeq();
        let terminalState: 'completed' | 'failed' | 'interrupted' = 'failed';
        let terminalAttempt = 0;
        let repairNote = '';
        const turnDeadline = Date.now() + (deps.config.turnBudgetMs ?? 55000);
        const askAboutConflicts = (conflicts: ReturnType<typeof scheduleConflicts>, attempt: number) => {
          const first = conflicts[0];
          const when = `${localDay(first.start_utc, tz)} ${minToHHmm(localMinutes(first.start_utc, tz))}–${minToHHmm(localMinutes(first.end_utc, tz))}`;
          const text = `${when}「${first.proposed.title}」与已有「${first.existing.title}」冲突${conflicts.length > 1 ? `，共 ${conflicts.length} 处` : ''}。尚未修改日程，请先选择调整方式。`;
          bestText = shownProse = text;
          emit({ event: 'delta', data: { seq: assistantSeq, text, attempt: attempt + 1 } as any });
          emit({ event: 'artifact', data: { seq: nextSeq(), kind: 'question_card', payload: { type: 'question_card', title: '需要先解决时间冲突', questions: [{ text: text.slice(0, 140), options: ['先调整已有安排', '修改新安排的时间', '暂不添加新安排'] }] } } });
          terminalState = 'completed';
        };
        for (let attempt = 0; attempt < 3; attempt++) {
          terminalAttempt = attempt;
          if (attempt > 0) {
            emittedProse = ''; shownProse = ''; replacedThisAttempt = false;
            emit({ event: 'delta', data: { seq: assistantSeq, text: '', attempt } as any });
          }
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
                  const protocol = prose.indexOf('<');
                  const cut = Math.min(tick < 0 ? prose.length : tick, brace < 0 ? prose.length : brace, protocol < 0 ? prose.length : protocol);
                  const safe = prose.slice(0, cut);
                  if (safe.length > emittedProse.length) {
                    const replace = attempt > 0 && !replacedThisAttempt;
                    const text = replace ? safe : safe.slice(emittedProse.length);
                    replacedThisAttempt = true;
                    emittedProse = safe;
                    shownProse = replace ? safe : shownProse + text;
                    emit({ event: 'delta', data: { seq: p.data.seq, text, attempt } as any });
                  }
                  continue;
                }
                if (p.event === 'status' || p.event === 'error') continue;
                emit(p);
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
          bestText = finalText;
          if (projector.hasFailed()) {
            if (attempt < 2) { repairNote = '\n上一轮上游失败，本轮重新生成完整答案。'; continue; }
            bestText = shownProse = '模型连接失败，本轮未修改日程，请重试。';
            emit({ event: 'delta', data: { seq: assistantSeq, text: bestText, attempt: attempt + 1 } as any });
            terminalState = 'failed';
            break;
          }
          if (!projector.isTerminal()) terminalState = 'failed';
          if (!finalText.trim()) {
            if (attempt < 2 && turnDeadline - Date.now() > 8000) { repairNote = '\n上一轮没有任何输出。不要调用工具，直接给出答案或 JSON 产物。'; continue; }
            terminalState = 'failed';
            emit({ event: 'error', data: { seq: nextSeq(), code: 'empty_response', message: 'AI 没有返回内容，请重试', diagnostic_id: crypto.randomUUID() } });
            break;
          }
          if (/<[^>]*(?:DSML|tool_call|function_call)/i.test(finalText)) {
            bestText = '';
            if (attempt < 2) {
              repairNote = '\n上轮返回了内部工具调用标记而不是答案。不要联网或调用工具，仅根据现有日历给出完整 JSON 产物；信息不够时给 question_card。';
              continue;
            }
            terminalState = 'failed';
            emit({ event: 'error', data: { seq: nextSeq(), code: 'artifact_invalid', message: '模型未生成有效方案，本轮未修改日程，请重试', diagnostic_id: crypto.randomUUID() } });
            break;
          }
          const parsed = parseModelText(finalText, day, tz);
          if (parsed) {
            // 纯 no-op 操作（改回原值/原地移动）过滤掉；全 no-op 的 patch 等同无改动，按纯文本回复。
            if (parsed.kind === 'patch' && planState?.plan?.id) {
              const world = [...(planState.blocks ?? []), ...sharedBlocks];
              const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
              const isNoop = (op: any): boolean => {
                if (op.op === 'update_plan') return Object.entries(op.patch ?? {}).every(([k, v]) => same((planState.plan as any)[k], v));
                if (op.op === 'update_block') { const b = world.find((x) => x.id === op.id); return !!b && Object.entries(op.patch ?? {}).every(([k, v]) => same((b as any)[k], v)); }
                if (op.op === 'move_block') { const b = world.find((x) => x.id === op.id); return !!b && b.start_utc === op.start_utc && b.end_utc === op.end_utc; }
                if (op.op === 'update_task_def') { const t = planState.task_defs.find((x) => x.key === op.key); return !!t && Object.entries(op.patch ?? {}).every(([k, v]) => same((t as any)[k], v)); }
                return false;
              };
              (parsed.value as any).ops = ((parsed.value as any).ops ?? []).filter((op: any) => !isNoop(op));
            }
            let preview: unknown;
            let claims: string[] = [];
            const proseNow = splitArtifactText(finalText).prose;
            // 空 ops 的 patch = 没有改动：按纯文本回复处理，不弹调整卡（寒暄/确认类消息不该产生应用入口）。
            if (parsed.kind === 'patch' && !(parsed.value as any).ops?.length) {
              const text = String((parsed.value as any).summary ?? '').replace(/[。.!！\s]+$/u, '').trim() || proseNow.trim() || '好的。';
              bestText = shownProse = text;
              emit({ event: 'delta', data: { seq: assistantSeq, text, attempt: attempt + 1 } as any });
              terminalState = 'completed';
              break;
            }
            let missingPrefs: { title: string; period: string }[] = [];
            if (parsed.kind === 'constraint_set') {
              missingPrefs = missingClaimedPrefs(proseNow, parsed.value.task_defs);
              if (missingPrefs.length && attempt < 1) {
                repairNote = `
正文承诺了时段但产物没写偏好：${missingPrefs.map((m) => `「${m.title}」应在${m.period === 'morning' ? '早上' : m.period === 'afternoon' ? '下午' : '下班后/晚上'}`).join('；')}。请给对应任务补 preferred_period，或改正文不要承诺具体时段。`;
                continue;
              }
              // 契约层守卫：新计划里落在「既有整天不可用日」或「同名同日既有安排」的固定占用直接忽略，
              // 模型爱把旅游大块抄进新计划，靠修复提示屡劝不改；忽略项在方案卡 notes 里明示。
              const unavailableDays = [...new Set([...foreignBlocks, ...sharedBlocks].map((b: any) => b.unavailable_date).filter(Boolean))];
              const existingTitleDay = new Set([...foreignBlocks, ...sharedBlocks].map((b: any) => `${b.title}|${localDay(b.start_utc, tz)}`));
              const droppedFixed: string[] = [];
              parsed.value.constraints = parsed.value.constraints.filter((p: any) => {
                if ((p.type !== 'fixed_block' && p.type !== 'busy_window') || !p.date) return true;
                if (unavailableDays.includes(p.date) || existingTitleDay.has(`${p.title}|${p.date}`)) { droppedFixed.push(`${p.title} ${p.date}`); return false; }
                return true;
              });
              const out = previewSolve(parsed.value);
              const fresh = out.blocks.filter(b => !sharedBlocks.some(s => s.id === b.id));
              const conflictMeta = { horizon_start: parsed.value.horizon_start ?? day, horizon_days: parsed.value.horizon_days, timezone: tz };
              const crossConflicts = scheduleConflicts(fresh, parsed.value.constraints.map((payload, i) => ({ id: `candidate-${i}`, payload, source: 'ai' as const, enabled: true })), [...foreignBlocks, ...sharedBlocks], conflictMeta);
              // 引擎仍把循环任务塞进不可用日/照抄块时：自动修正一轮，仍冲突才问用户。
              const onUnavailable = fresh.filter((b: any) => unavailableDays.includes(localDay(b.start_utc, tz)));
              const copies = fresh.filter((b: any) => [...foreignBlocks, ...sharedBlocks].some((e: any) => e.title === b.title && localDay(e.start_utc, tz) === localDay(b.start_utc, tz)));
              if ((onUnavailable.length || copies.length) && attempt < 2) {
                repairNote = `
${copies.length ? `新计划照抄了其他计划/共享日历的既有安排：${copies.map((b: any) => `「${b.title}」${localDay(b.start_utc, tz)}`).join('；')}。新计划只包含用户本轮提到的任务，删除这些复制块。` : ''}${onUnavailable.length ? `以下日期整天不可用：${unavailableDays.filter((d) => onUnavailable.some((b: any) => localDay(b.start_utc, tz) === d)).join('、')}；循环任务必须整天跳过这些日期，不要塞进子行程间隙。` : ''}请重新输出完整 constraint_set。`;
                continue;
              }
              if (crossConflicts.length) { askAboutConflicts(crossConflicts, attempt); break; }
              if (out.violations.length && attempt < 2) {
                repairNote = `
预排程不可行：${out.violations.map((v: any) => v.reason).join('；')}。保持用户明确要求的次数和时长，调整其他可用时段；确实无法满足时输出 question_card，请用户选择取舍，不得自动缩水。`;
                continue;
              }
              const nights = nightBlockCount(out.blocks);
              if (nights >= 3 && attempt < 2) {
                repairNote = `
预排程有 ${nights} 个任务落在 23:00–06:00 深夜/凌晨，违反作息保护。请重新输出 constraint_set：把任务安排在白天/晚上的合理时段；只有用户明确要求深夜时才用 include_quiet:true。`;
                continue;
              }
              claims = scheduleClaimIssues(proseNow, { task_defs: parsed.value.task_defs, blocks: fresh, reference_day: day, ...conflictMeta });
              const base: any = { feasibility: out.feasibility, unplaced: out.unplaced, violations: out.violations, compromises: out.compromises };
              if (droppedFixed.length) base.notes = [...(base.notes ?? []), `已忽略与既有整天安排重复的固定占用：${droppedFixed.join('；')}`];
              if (nights >= 3) base.notes = [...(base.notes ?? []), `有 ${nights} 个任务排在 23:00–06:00 深夜时段，请确认是否符合你的作息`];
              if (out.violations.length) {
                const trimmed = trimArtifactToFit(parsed.value, { horizon_start: parsed.value.horizon_start ?? day, timezone: tz, now_ms: nowMs, extra_constraints: foreignCuts }, sharedBlocks.map((b) => ({ ...b, pinned: true })));
                if (trimmed) base.proposal = { changes: trimmed.changes, suggested: { ...trimmed.draft, clarifications_needed: [...trimmed.draft.clarifications_needed ?? [], `容量不足，可接受的取舍：${trimmed.changes.join('；')}。`] } };
              }
              preview = base;
            } else if (parsed.kind === 'patch' && planState?.plan?.id) {
              // 公共日历块不在 plan.blocks 里，但细化/请假会按 id 删改它们：并入后再应用，避免误报「目标不存在」。
              const sharedIdSet = new Set(sharedBlocks.map((b) => b.id));
              const stateWithShared = { ...planState, blocks: [...(planState.blocks ?? []), ...sharedBlocks] };
              parsed.value.ops = inheritUnavailableDates(stateWithShared.blocks, parsed.value.ops, tz);
              const applied = applyPatch(stateWithShared as any, parsed.value.ops as any);
              const ownAfter = applied.state.blocks.filter((b: any) => !sharedIdSet.has(b.id));
              const sharedAfter = applied.state.blocks.filter((b: any) => sharedIdSet.has(b.id));
              missingPrefs = missingClaimedPrefs(proseNow, applied.state.task_defs);
              if (missingPrefs.length && attempt < 1) {
                repairNote = `
正文承诺了时段但产物没写偏好：${missingPrefs.map((m) => `「${m.title}」应在${m.period === 'morning' ? '早上' : m.period === 'afternoon' ? '下午' : '下班后/晚上'}`).join('；')}。请补 preferred_period 或改正文。`;
                continue;
              }
              if (applied.missing.length && attempt < 2) {
                repairNote = `
调整目标已不存在：${applied.missing.slice(0, 5).join('、')}。请基于当前计划重新输出 patch，不要臆造 id/key。`;
                continue;
              }
              const explicitLayout = hasExplicitBlockOps(parsed.value.ops as any);
              const explicitReschedule = parsed.value.ops.some((op: any) => op.op === 'reschedule');
              // 与本地落库同口径：显式块操作 + 输入变更 + reschedule 时重排，显式块与未受影响任务保留。
              const willReschedule = applied.requiresReschedule && (!explicitLayout || (explicitReschedule && changesScheduleInputs(parsed.value.ops as any)));
              const pinned = willReschedule
                ? reschedulePinnedBlocks(stateWithShared as any, applied.state as any, parsed.value.ops as any).filter((b: any) => !sharedIdSet.has(b.id))
                : ownAfter.filter((b: any) => b.pinned || b.origin === 'manual' || ['completed', 'in_progress', 'partial'].includes(String(b.status ?? '')));
              const out = solve({
                engine_version: ENGINE_VERSION,
                now_ms: nowMs,
                horizon_start: planState.plan.horizon_start,
                horizon_days: planState.plan.horizon_days,
                timezone: tz,
                task_defs: applied.state.task_defs,
                constraints: [...applied.state.constraints, ...foreignCuts, ...blockBusyCuts(sharedAfter as Block[], tz)],
                pinned_blocks: [...pinned, ...sharedAfter.map((b: any) => ({ ...b, pinned: true }))],
              });
              if (willReschedule && out.violations.length && attempt < 2) {
                repairNote = `
应用这条调整会排不下：${out.violations.map((v: any) => v.reason).join('；')}。请调整非固定落位，保留用户确认的时长、次数与已钉住块；无法满足时给 question_card 让用户确认取舍，不得自动减少任务。`;
                continue;
              }
              // 一致性检查：正文承诺的删除/挪动必须有对应操作；应用后不得新引入重叠。
              const ownOut = out.blocks.filter((b: any) => !sharedIdSet.has(b.id));
              const effectiveBlocks = willReschedule ? ownOut : ownAfter;
              const knownBlocks = [...(planState.blocks ?? []), ...sharedBlocks];
              claims = scheduleClaimIssues(`${proseNow}\n${parsed.value.summary}`, { task_defs: applied.state.task_defs, blocks: effectiveBlocks, reference_day: day, ...planState.plan });
              const conflictKey = (c: ReturnType<typeof scheduleConflicts>[number]) => `${c.proposed.title}|${c.existing.title}|${c.start_utc}|${c.end_utc}`;
              const beforeConflicts = new Set(scheduleConflicts(planState.blocks, planState.constraints, foreignBlocks, planState.plan).map(conflictKey));
              const crossConflicts = scheduleConflicts(effectiveBlocks, applied.state.constraints, foreignBlocks, planState.plan).filter(c => !beforeConflicts.has(conflictKey(c)));
              if (crossConflicts.length) { askAboutConflicts(crossConflicts, attempt); break; }
              const removals = claimedRemovals(proseNow, parsed.value.ops, knownBlocks);
              const moves = claimedMovesUnmet(proseNow, parsed.value.ops, knownBlocks);
              const overlaps = introducedOverlaps([...(planState.blocks ?? []), ...sharedBlocks], [...effectiveBlocks, ...sharedAfter]);
              const problems = [
                ...removals.map((t) => `正文说删除/替换「${t}」，但操作里没有对应的 remove_block，原块仍会留在日历上`),
                ...moves.map((t) => `正文说挪动「${t}」，但操作里既没有 move_block/update_block，也没有 reschedule+约束调整`),
                ...overlaps.map((p) => `${overlapText(p)}（这次调整新引入的重叠）`),
              ];
              if (problems.length && attempt < 2) {
                repairNote = `
正文承诺与实际操作不一致：${problems.slice(0, 6).join('；')}。请重新输出 patch：细化/替换要先 remove_block 原块再 add_block 子块；说挪动就要真的挪；子块之间及与保留块不得重叠。`;
                continue;
              }
              if (problems.length) {
                bestText = shownProse = `调整未通过校验，本轮未修改日程：${problems.slice(0, 6).join('；')}`;
                emit({ event: 'delta', data: { seq: assistantSeq, text: bestText, attempt: attempt + 1 } as any });
                emit({ event: 'error', data: { seq: nextSeq(), code: 'artifact_invalid', message: '调整仍存在遗漏或重叠，请重试', diagnostic_id: crypto.randomUUID() } });
                terminalState = 'failed';
                break;
              }
              const nights = nightBlockCount(effectiveBlocks);
              if (nights >= 3 && attempt < 2) {
                repairNote = `
这次调整会让 ${nights} 个任务落在 23:00–06:00 深夜/凌晨，违反作息保护。请改到白天/晚上的合理时段；只有用户明确要求深夜时才用 include_quiet:true。`;
                continue;
              }
              const notes = [
                ...preferenceNotes(applied.state, out.blocks),
                ...problems,
                ...(nights >= 3 ? [`有 ${nights} 个任务排在 23:00–06:00 深夜时段，请确认是否符合你的作息`] : []),
              ];
              preview = {
                feasibility: (out as any).feasibility, unplaced: (out as any).unplaced, violations: out.violations,
                compromises: out.compromises, notes,
              };
            }
            if (claims.length) {
              if (attempt < 2) {
                repairNote = `\n正文数字或时间与实际预排程不一致：${claims.slice(0, 6).join('；')}。请修正正文或产物，使每周次数、实际日期数和具体时段与实际排程相符，不得擅自减少用户要求。`;
                continue;
              }
              // 重试仍不收敛：不整轮作废——产物照常发出，正文偏差在方案卡 notes 里明确纠正（自动纠正或明确告知用户）。
              const base = (preview as any) ?? (preview = {});
              base.notes = [...(base.notes ?? []), ...claims.map((c) => `正文纠正：${c}`)];
            }
            if (!proseNow.trim()) {
              const summary = String((parsed.value as any).summary ?? '').replace(/[。.!！\s]+$/u, '');
              const fallback = parsed.kind === 'patch' ? `调整建议：${summary || '按本轮要求调整日程'}。请确认后应用。`
                : parsed.kind === 'question_card' ? `需要先确认：${parsed.value.questions.map(q => q.text).join('；')}`
                : '方案已生成，请在方案卡核对实际排程后确认。';
              bestText = fallback;
              shownProse = fallback;
              emit({ event: 'delta', data: { seq: assistantSeq, text: fallback, attempt: attempt + 1 } as any });
            }
            if (missingPrefs.length) {
              const base = (preview as any) ?? (preview = {});
              base.notes = [...(base.notes ?? []), ...missingPrefs.map((m) => `正文说「${m.title}」放在${m.period === 'morning' ? '早上' : m.period === 'afternoon' ? '下午' : '下班后'}，但产物未设置时段偏好，实际排程可能不符；可在方案卡里调整后重新生成`)];
            }
            if (parsed.kind === 'question_card') {
              const conflictQ = (parsed.value as any).questions?.some((q: any) => /冲突|重叠|撞/.test(q.text ?? ''));
              // 时间冲突的标准问卡由服务端按真实预排程重叠生成（具体日期/完整标题/标准选项）；模型自问冲突先退回一轮。
              if (conflictQ && attempt < 2) {
                repairNote = '\n不要自行追问时间冲突：请直接输出完整 constraint_set（含用户本轮提到的新固定占用）；服务端会预排程，并按真实重叠生成带具体日期与标准选项的问题卡。';
                continue;
              }
              // 冲突类问题卡保留模型的具体描述，但必须提供三条标准解决路径，供用户一键选择。
              const CANON = ['先调整已有安排', '修改新安排的时间', '暂不添加新安排'];
              for (const q of (parsed.value as any).questions ?? []) {
                if (!/冲突|重叠|撞/.test(q.text ?? '')) continue;
                q.options = [...CANON, ...(q.options ?? []).filter((o: string) => !CANON.includes(o)).slice(0, 1)];
              }
            }
            emit({ event: 'artifact', data: { seq: nextSeq(), kind: parsed.kind, payload: parsed.value, ...(preview ? { preview } : {}) } });
            terminalState = 'completed';
            break;
          }
          const expectsArtifact = /```json|^\s*\{/.test(finalText);
          // 寒暄/明确否定排程意图的消息不算排程请求（「不要修改任何计划」不该命中「修改…计划」）。
          const harmless = /打个招呼|只用一句话|不要创建|不要修改|别创建|别修改|不要调用工具|别调用工具/.test(chat.text);
          const requestedArtifact = !harmless && (/(制定|做|排|列|生成|安排|规划|调整|修改|改|加|删).{0,8}(计划|方案|日程|作息|表)|直接给方案|帮我排/.test(chat.text)
            || /(每天|每周|每次|天天|工作日)[^。\n]{0,24}?\d+\s*(分钟|小时)/.test(chat.text)
            || (!!planState?.plan?.id && /细化|拆分|做细|规划详细|规划细|挪|移动|调整|改到|新增|再加|删除|取消/.test(chat.text)));
          if ((expectsArtifact || requestedArtifact) && attempt < 2) {
            repairNote = '\n输出被截断或只有文字。本轮必须直接输出完整闭合的 ```json 产物：省略冗长 notes，但保留用户要求的任务和约束；不能用漏项来伪装成功。';
            continue;
          }
          if (expectsArtifact || requestedArtifact) {
            bestText = shownProse = '本轮没有生成可应用的有效方案，日程保持不变。';
            emit({ event: 'delta', data: { seq: assistantSeq, text: bestText, attempt: attempt + 1 } as any });
            terminalState = 'failed';
            emit({ event: 'error', data: { seq: nextSeq(), code: 'artifact_invalid', message: 'AI 返回的方案不完整，请重试', diagnostic_id: crypto.randomUUID() } });
          } else {
            terminalState = projector.isTerminal() && !projector.hasFailed() ? 'completed' : 'failed';
          }
          break;
        }
        const finalProse = splitArtifactText(bestText).prose;
        if (finalProse && finalProse !== shownProse) {
          emit({ event: 'delta', data: { seq: assistantSeq, text: finalProse, attempt: terminalAttempt + 1 } as any });
        }
        if (terminalState === 'failed' && !errorSent) emit({ event: 'error', data: { seq: nextSeq(), code: 'artifact_invalid', message: '本轮未完成有效生成，日程未修改，请重试', diagnostic_id: crypto.randomUUID() } });
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