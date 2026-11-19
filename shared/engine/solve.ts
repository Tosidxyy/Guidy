import { DEFAULT_ACTIVE, DEFAULT_MUTEX_GAP, MIN_FRAGMENT_MIN, PERIOD_BOUNDS, PRIORITY_WEIGHT } from '../constants.ts';
import type { Block, Compromise, Constraint, SolveInput, SolveOutput, TaskDef, Violation } from '../types.ts';
import { dayList, gapBetween, hhmmToMin, localDay, localMinutes, subtractIntervals, utcAt, weekdayOfDay, type Interval } from './time.ts';

interface DayContext {
  day: string;
  weekday: number;
  active: Interval[];
  busy: Interval[];
  occupied: Interval[];
  blocks: Block[];
}

interface MutexRule {
  id: string;
  kind: 'category' | 'task';
  a: string;
  b: string;
  mode: 'no_adjacent' | 'no_same_day';
  strength: 'soft' | 'hard';
}

function matchesSubject(rule: MutexRule, side: 'a' | 'b', block: { task_key?: string; category: string }): boolean {
  const value = side === 'a' ? rule.a : rule.b;
  return rule.kind === 'task' ? block.task_key === value : block.category === value;
}

function preferredPeriodFor(task: TaskDef, constraints: Constraint[]): string | undefined {
  if (task.preferred_period) return task.preferred_period;
  for (const c of constraints) {
    if (!c.enabled || c.payload.type !== 'preferred_period') continue;
    const p = c.payload;
    if (p.task_key === task.key || (p.category && p.category === task.category)) return p.period;
  }
  return undefined;
}

export function solve(input: SolveInput): SolveOutput {
  const { timezone: tz, horizon_start, horizon_days } = input;
  const constraints = input.constraints.filter((c) => c.enabled);
  const days = dayList(horizon_start, horizon_days, tz);
  const compromises: Compromise[] = [];
  const violations: Violation[] = [];
  let idCounter = 0;
  const usedIds = new Set<string>();
  const nextId = () => {
    let id = `eng-${++idCounter}`;
    while (usedIds.has(id)) id = `eng-${++idCounter}`;
    return id;
  };

  const activeCons = constraints.filter((c) => c.payload.type === 'active_window');
  const busyCons = constraints.filter((c) => c.payload.type === 'busy_window');
  const capCons = constraints.filter((c) => c.payload.type === 'daily_cap');
  const bufferMin = constraints.reduce((m, c) => (c.payload.type === 'buffer' ? Math.max(m, c.payload.minutes) : m), 0);
  const mutexRules: MutexRule[] = constraints
    .filter((c) => c.payload.type === 'mutex')
    .map((c) => {
      const p = c.payload as Extract<Constraint['payload'], { type: 'mutex' }>;
      return { id: c.id, kind: p.subjects.kind, a: p.subjects.values[0], b: p.subjects.values[1], mode: p.mode, strength: p.strength };
    });

  // 结构矛盾前置检测：硬性同日互斥 × 每日任务必然无解（对方至少占一天）。
  // 提前给出指向互斥约束的精确违例，避免落成「可用时段不足」这类误导文案。
  const taskByKey = new Map(input.task_defs.map((t) => [t.key, t]));
  const structuralBlocked = new Set<string>();
  for (const rule of mutexRules) {
    if (rule.strength !== 'hard' || rule.mode !== 'no_same_day' || rule.kind !== 'task') continue;
    const dailyKey = [rule.a, rule.b].find((k) => taskByKey.get(k)?.frequency.type === 'daily');
    if (!dailyKey) continue;
    const otherKey = dailyKey === rule.a ? rule.b : rule.a;
    structuralBlocked.add(dailyKey);
    violations.push({
      task_key: dailyKey,
      constraint_id: rule.id,
      reason: `「${taskByKey.get(dailyKey)!.title}」是每日任务，但与「${taskByKey.get(otherKey)?.title ?? otherKey}」设置了硬性同日互斥：对方至少占用一天，当天放不下每日任务`,
      suggestion: '将该互斥改为软性，或让每日必需任务（如吃饭）豁免于「清空某天」类约束',
    });
  }

  const ctxByDay = new Map<string, DayContext>();
  for (const day of days) {
    const weekday = weekdayOfDay(day, tz);
    const active: Interval[] = [];
    for (const c of activeCons) {
      const p = c.payload as Extract<Constraint['payload'], { type: 'active_window' }>;
      if (p.weekdays && !p.weekdays.includes(weekday)) continue;
      active.push({ start: hhmmToMin(p.start), end: hhmmToMin(p.end) });
    }
    const busy: Interval[] = [];
    for (const c of busyCons) {
      const p = c.payload as Extract<Constraint['payload'], { type: 'busy_window' }>;
      const hit = p.date !== undefined ? p.date === day : p.weekday === weekday;
      if (hit) busy.push({ start: hhmmToMin(p.start), end: hhmmToMin(p.end) });
    }
    ctxByDay.set(day, {
      day,
      weekday,
      active: active.length ? active : [{ start: DEFAULT_ACTIVE[0], end: DEFAULT_ACTIVE[1] }],
      busy,
      occupied: [],
      blocks: [],
    });
  }

  const capRemaining = new Map<string, number>();
  const capKey = (day: string, category: string) => `${day}|${category}`;
  const capFor = (day: string, category: string): number => {
    const key = capKey(day, category);
    if (!capRemaining.has(key)) {
      const cons = capCons.find((c) => (c.payload as Extract<Constraint['payload'], { type: 'daily_cap' }>).category === category);
      capRemaining.set(key, cons ? (cons.payload as Extract<Constraint['payload'], { type: 'daily_cap' }>).max_minutes : Infinity);
    }
    return capRemaining.get(key)!;
  };
  const consumeCap = (day: string, category: string, minutes: number) => {
    const key = capKey(day, category);
    capFor(day, category);
    capRemaining.set(key, capRemaining.get(key)! - minutes);
  };

  const outputBlocks: Block[] = [];
  const registerBlock = (ctx: DayContext, block: Block, interval: Interval) => {
    usedIds.add(block.id);
    ctx.occupied.push(interval);
    ctx.blocks.push(block);
    outputBlocks.push(block);
    consumeCap(ctx.day, block.category, interval.end - interval.start);
  };

  for (const c of constraints) {
    if (c.payload.type !== 'fixed_block') continue;
    const p = c.payload;
    for (const ctx of ctxByDay.values()) {
      const hit = p.date !== undefined ? p.date === ctx.day : p.weekday === ctx.weekday;
      if (!hit) continue;
      const interval = { start: hhmmToMin(p.start), end: hhmmToMin(p.end) };
      registerBlock(ctx, {
        id: nextId(), title: p.title, category: p.category,
        start_utc: utcAt(ctx.day, interval.start, tz), end_utc: utcAt(ctx.day, interval.end, tz),
        priority: 'high', pinned: true, origin: 'fixed',
      }, interval);
    }
  }

  for (const pinned of input.pinned_blocks) {
    const day = localDay(pinned.start_utc, tz);
    const ctx = ctxByDay.get(day);
    if (!ctx) continue;
    const interval = { start: localMinutes(pinned.start_utc, tz), end: localMinutes(pinned.end_utc, tz) };
    registerBlock(ctx, { ...pinned }, interval);
  }

  const pinnedByTask = new Map<string, { count: number; days: Set<string> }>();
  for (const pinned of input.pinned_blocks) {
    if (!pinned.task_key) continue;
    const day = localDay(pinned.start_utc, tz);
    if (!ctxByDay.has(day)) continue;
    const entry = pinnedByTask.get(pinned.task_key) ?? { count: 0, days: new Set<string>() };
    entry.count += 1;
    entry.days.add(day);
    pinnedByTask.set(pinned.task_key, entry);
  }

  const mutexConflict = (ctx: DayContext, candidate: { task_key?: string; category: string }, interval: Interval): MutexRule | null => {
    for (const rule of mutexRules) {
      const selfA = matchesSubject(rule, 'a', candidate);
      const selfB = matchesSubject(rule, 'b', candidate);
      if (!selfA && !selfB) continue;
      const otherSide = selfA ? 'b' : 'a';
      for (const existing of ctx.blocks) {
        if (!matchesSubject(rule, otherSide, existing)) continue;
        if (rule.mode === 'no_same_day') return rule;
        const exInterval = { start: localMinutes(existing.start_utc, tz), end: localMinutes(existing.end_utc, tz) };
        if (gapBetween(interval, exInterval) < Math.max(bufferMin, DEFAULT_MUTEX_GAP)) return rule;
      }
    }
    return null;
  };

  const freeSlots = (ctx: DayContext): Interval[] => {
    const cuts = [...ctx.busy];
    for (const occ of ctx.occupied) {
      cuts.push({ start: occ.start - bufferMin, end: occ.end + bufferMin });
    }
    return subtractIntervals(ctx.active, cuts).filter((s) => s.end - s.start >= MIN_FRAGMENT_MIN);
  };

  const periodScore = (period: string | undefined, interval: Interval): number => {
    if (!period) return 0;
    const [ps, pe] = PERIOD_BOUNDS[period];
    const overlap = Math.max(0, Math.min(interval.end, pe) - Math.max(interval.start, ps));
    return overlap >= (interval.end - interval.start) * 0.8 ? 0 : 1;
  };

  const candidateIntervals = (ctx: DayContext, slot: Interval, task: TaskDef, candidate: { task_key?: string; category: string }, period: string | undefined): Interval[] => {
    const starts = new Set<number>([slot.start]);
    for (const rule of mutexRules) {
      const selfA = matchesSubject(rule, 'a', candidate);
      const selfB = matchesSubject(rule, 'b', candidate);
      if (!selfA && !selfB) continue;
      const other = selfA ? 'b' : 'a';
      for (const ex of ctx.blocks) {
        if (!matchesSubject(rule, other, ex)) continue;
        const gap = Math.max(bufferMin, DEFAULT_MUTEX_GAP);
        const after = localMinutes(ex.end_utc, tz) + gap;
        if (after > slot.start && after < slot.end) starts.add(after);
        const before = localMinutes(ex.start_utc, tz) - gap - task.duration_min;
        if (before > slot.start && before < slot.end) starts.add(before);
      }
    }
    if (period) {
      const ps = PERIOD_BOUNDS[period][0];
      if (ps > slot.start && ps < slot.end) starts.add(ps);
    }
    const out: Interval[] = [];
    for (const s of [...starts].sort((a, b) => a - b)) {
      const avail = slot.end - s;
      if (!task.splittable && avail < task.duration_min) continue;
      if (task.splittable && avail < MIN_FRAGMENT_MIN) continue;
      out.push({ start: s, end: s + Math.min(avail, task.duration_min) });
    }
    return out;
  };

  const sortedTasks = [...input.task_defs].sort((a, b) => {
    const pw = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    if (pw !== 0) return pw;
    const aw = a.preferred_period ? 0 : 1;
    const bw = b.preferred_period ? 0 : 1;
    if (aw !== bw) return aw - bw;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.key.localeCompare(b.key);
  });

  const makeBlock = (task: TaskDef, ctx: DayContext, interval: Interval): Block => ({
    id: nextId(), task_key: task.key, title: task.title, category: task.category,
    start_utc: utcAt(ctx.day, interval.start, tz), end_utc: utcAt(ctx.day, interval.end, tz),
    priority: task.priority, pinned: false, origin: 'engine',
    ...(task.notes ? { notes: task.notes } : {}),
  });

  const recordSoft = (task: TaskDef, block: Block, ctx: DayContext, interval: Interval) => {
    const period = preferredPeriodFor(task, constraints);
    if (period && periodScore(period, interval) === 1) {
      compromises.push({ block_id: block.id, task_key: task.key, reason: `「${task.title}」未落在偏好的${period === 'morning' ? '早晨' : period === 'afternoon' ? '下午' : period === 'evening' ? '傍晚' : '夜间'}时段` });
    }
    const rule = mutexConflict(ctx, block, interval);
    if (rule && rule.strength === 'soft') {
      compromises.push({ block_id: block.id, task_key: task.key, constraint_id: rule.id, reason: `「${task.title}」与互斥任务同日相邻或共存（软约束妥协）` });
    }
  };

  for (const task of sortedTasks) {
    const pre = pinnedByTask.get(task.key);
    let placedCount = pre?.count ?? 0;
    const usedDays = new Set<string>(pre?.days ?? []);
    const period = preferredPeriodFor(task, constraints);
    const candidate = { task_key: task.key, category: task.category };

    /** 在允许的日期里落一次；允许集合为空表示整个 horizon。 */
    const placeOne = (allowed?: Set<string>): boolean => {
      const bestRef: { current: { ctx: DayContext; interval: Interval; score: number } | null } = { current: null };
      for (const ctx of ctxByDay.values()) {
        if (allowed && !allowed.has(ctx.day)) continue;
        if (usedDays.has(ctx.day)) continue;
        if (capFor(ctx.day, task.category) < (task.splittable ? MIN_FRAGMENT_MIN : task.duration_min)) continue;
        for (const slot of freeSlots(ctx)) {
          for (const interval of candidateIntervals(ctx, slot, task, candidate, period)) {
            const conflict = mutexConflict(ctx, candidate, interval);
            if (conflict && conflict.strength === 'hard') continue;
            const softPenalty = conflict ? 100000 : 0;
            const score = periodScore(period, interval) * 1000000 + softPenalty + days.indexOf(ctx.day) * 10000 + interval.start;
            const best = bestRef.current;
            if (!best || score < best.score) bestRef.current = { ctx, interval, score };
          }
        }
        const best = bestRef.current;
        if (best && !task.splittable && best.score < 100000) break;
      }

      const best = bestRef.current;
      if (!best) return false;
      const { ctx, interval } = best;
      const minutes = interval.end - interval.start;
      const block = makeBlock(task, ctx, interval);
      registerBlock(ctx, block, interval);
      usedDays.add(ctx.day);
      recordSoft(task, block, ctx, interval);
      if (task.splittable && minutes < task.duration_min) {
        let splitMinutesLeft = task.duration_min - minutes;
        while (splitMinutesLeft >= MIN_FRAGMENT_MIN) {
          let frag: { ctx: DayContext; interval: Interval } | null = null;
          let fallback: { ctx: DayContext; interval: Interval } | null = null;
          const fragTask = { ...task, duration_min: splitMinutesLeft };
          for (const fctx of ctxByDay.values()) {
            if (allowed && !allowed.has(fctx.day)) continue;
            if (capFor(fctx.day, task.category) < MIN_FRAGMENT_MIN) continue;
            for (const slot of freeSlots(fctx)) {
              for (const fi of candidateIntervals(fctx, slot, fragTask, candidate, period)) {
                if (fi.end - fi.start < MIN_FRAGMENT_MIN) continue;
                const conflict = mutexConflict(fctx, candidate, fi);
                if (conflict && conflict.strength === 'hard') continue;
                if (!conflict) { frag = { ctx: fctx, interval: fi }; break; }
                if (!fallback) fallback = { ctx: fctx, interval: fi };
              }
              if (frag) break;
            }
            if (frag) break;
          }
          if (!frag) frag = fallback;
          if (!frag) break;
          const fb = makeBlock(task, frag.ctx, frag.interval);
          registerBlock(frag.ctx, fb, frag.interval);
          recordSoft(task, fb, frag.ctx, frag.interval);
          splitMinutesLeft -= frag.interval.end - frag.interval.start;
        }
        if (splitMinutesLeft > 0) {
          violations.push({ task_key: task.key, reason: `「${task.title}」拆分后仍有 ${splitMinutesLeft} 分钟无法落位`, suggestion: '放宽每日上限或增加可用时段' });
        }
      }
      return true;
    };

    // per_week 是「每周 count 次」：按 7 天一段逐周配额，而不是整个 horizon 只排 count 次。
    const weekSegments: string[][] = [];
    for (let i = 0; i < days.length; i += 7) weekSegments.push(days.slice(i, i + 7));
    let target: number;
    if (task.frequency.type === 'per_week') {
      const { count } = task.frequency;
      target = 0;
      for (const seg of weekSegments) {
        const quota = seg.length === 7 ? count : Math.max(1, Math.round((count * seg.length) / 7));
        target += quota;
        const allowed = new Set(seg);
        const pinnedHere = [...(pre?.days ?? [])].filter((d) => allowed.has(d)).length;
        let need = Math.max(0, quota - pinnedHere);
        while (need > 0 && placeOne(allowed)) { placedCount += 1; need -= 1; }
      }
    } else {
      target = task.frequency.type === 'daily' ? days.length : 1;
      while (placedCount < target && placeOne()) placedCount += 1;
    }

    if (placedCount < target && !structuralBlocked.has(task.key)) {
      const missing = target - placedCount;
      const capCons2 = capCons.find((c) => (c.payload as Extract<Constraint['payload'], { type: 'daily_cap' }>).category === task.category);
      violations.push({
        task_key: task.key,
        constraint_id: capCons2?.id,
        reason: `「${task.title}」还有 ${missing} 次（共 ${missing * task.duration_min} 分钟）放不下：可用时段不足或每日上限已满`,
        suggestion: capCons2 ? `放宽「${task.category}」每日上限，或缩短单次时长` : '增加每日可用时段，或降低频次',
      });
    }
  }

  outputBlocks.sort((a, b) => a.start_utc.localeCompare(b.start_utc) || a.title.localeCompare(b.title));
  const placed = outputBlocks.filter((b) => b.origin === 'engine').length;
  return {
    blocks: outputBlocks,
    violations,
    compromises,
    stats: { placed, unplaced: violations.length, solve_ms: 0 },
  };
}