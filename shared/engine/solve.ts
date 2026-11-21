import { DEFAULT_ACTIVE, DEFAULT_MUTEX_GAP, MIN_FRAGMENT_MIN, PERIOD_BOUNDS, PRIORITY_WEIGHT, PREFERRED_DAY_START, QUIET_END, QUIET_START } from '../constants.ts';
import type { Block, Compromise, Constraint, Feasibility, SolveInput, SolveOutput, TaskDef, UnplacedWork, Violation } from '../types.ts';
import { blockBusyCuts, pastTodayCuts } from './availability.ts';
import { dayList, gapBetween, hhmmToMin, localDay, localMinutes, minToHHmm, subtractIntervals, utcAt, weekdayOfDay, type Interval } from './time.ts';

interface DayContext {
  day: string;
  weekday: number;
  active: Interval[];
  hasActiveCons: boolean;
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

// 最小可落位长度：碎片不得小于 MIN_FRAGMENT_MIN，但整块（或收尾整块）不受此限——
// 否则时长 <25min 的可拆分任务会被碎片门槛整体误杀。
const minPlacement = (duration: number) => Math.min(MIN_FRAGMENT_MIN, duration);

function matchesSubject(rule: MutexRule, side: 'a' | 'b', block: { task_key?: string; category: string }): boolean {
  const value = side === 'a' ? rule.a : rule.b;
  return rule.kind === 'task' ? block.task_key === value : block.category === value;
}

interface PeriodPref { period: string; bounds: [number, number]; custom?: boolean }

function preferredPeriodFor(task: TaskDef, constraints: Constraint[]): PeriodPref | undefined {
  let period: string | undefined = task.preferred_period;
  let bounds: [number, number] | undefined;
  for (const c of constraints) {
    if (!c.enabled || c.payload.type !== 'preferred_period') continue;
    const p = c.payload;
    if (p.task_key !== task.key && !(p.category && p.category === task.category)) continue;
    if (!period) period = p.period;
    if (!bounds && (p.start || p.end)) {
      const base = PERIOD_BOUNDS[p.period];
      bounds = [p.start ? hhmmToMin(p.start) : base[0], p.end ? hhmmToMin(p.end) : base[1]];
    }
  }
  if (!period) return undefined;
  return { period, bounds: bounds ?? PERIOD_BOUNDS[period], custom: !!bounds };
}

export function solve(input: SolveInput): SolveOutput {
  const { timezone: tz, horizon_start, horizon_days, now_ms } = input;
  const today = now_ms === undefined ? undefined : localDay(new Date(now_ms).toISOString(), tz);
  // The explicit clock replaces stale caller cuts without reading ambient time.
  const constraints = input.constraints.filter((c) => c.enabled && !(now_ms !== undefined && c.id === 'now-past' && c.payload.type === 'busy_window'));
  if (now_ms !== undefined) constraints.push(...pastTodayCuts(tz, horizon_start, horizon_days, now_ms));
  const days = dayList(horizon_start, horizon_days, tz);
  const pastDays = new Set(days.filter((day) => today !== undefined && day < today));
  const compromises: Compromise[] = [];
  const violations: Violation[] = [];
  const targetMinutes = new Map<string, number>();
  let structural = false;
  let idCounter = 0;
  const usedIds = new Set<string>();
  const nextId = () => {
    let id = `eng-${++idCounter}`;
    while (usedIds.has(id)) id = `eng-${++idCounter}`;
    return id;
  };

  const activeCons = constraints.filter((c) => c.payload.type === 'active_window');
  const busyCons = constraints.filter((c) => c.payload.type === 'busy_window');
  // pastTodayCuts 生成的「今天已过去」忙时：当天的容量缺口按妥协说明，不算排不下。
  const nowPastCons = constraints.find((c) => c.id === 'now-past' && c.payload.type === 'busy_window');
  const nowPastDay = nowPastCons?.payload.type === 'busy_window' ? nowPastCons.payload.date : undefined;
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
  // 同名固定块视为该任务的落位（用户指定了具体时间，如「明天下午2点学习两小时」）。
  const tasksByTitle = new Map<string, TaskDef[]>();
  for (const t of input.task_defs) {
    const k = t.title.trim();
    tasksByTitle.set(k, [...(tasksByTitle.get(k) ?? []), t]);
  }
  const structuralBlocked = new Set<string>();
  for (const rule of mutexRules) {
    if (rule.strength !== 'hard' || rule.mode !== 'no_same_day' || rule.kind !== 'task') continue;
    const dailyKey = [rule.a, rule.b].find((k) => taskByKey.get(k)?.frequency.type === 'daily');
    if (!dailyKey) continue;
    const otherKey = dailyKey === rule.a ? rule.b : rule.a;
    structuralBlocked.add(dailyKey);
    structural = true;
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
      let start = hhmmToMin(p.start);
      let end = hhmmToMin(p.end);
      // 深夜保护：AI 放宽的可用时段不得侵占 23:00–06:00，除非显式 include_quiet 或用户手工设置。
      const allowQuiet = p.include_quiet === true || c.source === 'user';
      if (!allowQuiet) {
        start = Math.max(start, QUIET_END);
        end = Math.min(end, QUIET_START);
        if (end <= start) continue;
      }
      active.push({ start, end });
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
      hasActiveCons: active.length > 0,
      busy,
      occupied: [],
      blocks: [],
    });
  }

  // 整天被占用的日子（旅行/考试等）：跳过而不是硬塞进缝隙。判定 = 忙碌覆盖 ≥8h
  // 且常见白昼段（07:00–23:00）剩余空闲不足 1h。刻意收窄的 active_window 不触发判定。
  // 无任务归属的 pinned 块（旅行行程、全天外出等手动承诺）与忙时同等参与判定。
  const intervalLen = (xs: Interval[]) => xs.reduce((n, x) => n + (x.end - x.start), 0);
  const pinnedCuts = blockBusyCuts(input.pinned_blocks.filter((b) => !b.task_key), tz);
  const extraBusyByDay = new Map<string, Interval[]>();
  for (const c of pinnedCuts) {
    const p = c.payload as Extract<Constraint['payload'], { type: 'busy_window' }>;
    const day = p.date!;
    extraBusyByDay.set(day, [...(extraBusyByDay.get(day) ?? []), { start: hhmmToMin(p.start), end: hhmmToMin(p.end) }]);
  }
  const blockedDays = new Set<string>();
  for (const ctx of ctxByDay.values()) {
    const busyAll = [...ctx.busy, ...(extraBusyByDay.get(ctx.day) ?? [])];
    const busyMin = 1440 - intervalLen(subtractIntervals([{ start: 0, end: 1440 }], busyAll));
    if (busyMin < 480) continue;
    const waking = [{ start: PREFERRED_DAY_START, end: QUIET_START }];
    if (intervalLen(subtractIntervals(waking, busyAll)) < 60) blockedDays.add(ctx.day);
  }
  for (const day of blockedDays) {
    const ctx = ctxByDay.get(day)!;
    const label = [...busyCons.map((c) => c.payload as Extract<Constraint['payload'], { type: 'busy_window' }>), ...pinnedCuts.map((c) => c.payload as Extract<Constraint['payload'], { type: 'busy_window' }>)]
      .filter((p) => (p.date !== undefined ? p.date === day : p.weekday === ctx.weekday))
      .sort((a, b) => (hhmmToMin(b.end) - hhmmToMin(b.start)) - (hhmmToMin(a.end) - hhmmToMin(a.start)))[0]?.label;
    compromises.push({ reason: `${day} 全天被「${label ?? '既有安排'}」占用，当天不安排任务` });
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
  const runningMinutes = new Map<string, number>();
  const lastEndByKey = new Map<string, string>();
  const registerBlock = (ctx: DayContext, block: Block, interval: Interval) => {
    usedIds.add(block.id);
    ctx.occupied.push(interval);
    ctx.blocks.push(block);
    outputBlocks.push(block);
    consumeCap(ctx.day, block.category, interval.end - interval.start);
    if (block.task_key) {
      const m = runningMinutes.get(block.task_key) ?? 0;
      runningMinutes.set(block.task_key, m + (interval.end - interval.start));
      const prev = lastEndByKey.get(block.task_key);
      if (!prev || block.end_utc > prev) lastEndByKey.set(block.task_key, block.end_utc);
    }
  };
  // 固定事件（会议/上课）与已钉住的块不得互相重叠：这是硬约束，做不到就明确违例。
  const assertNoOverlap = (ctx: DayContext, block: Block, interval: Interval, constraintId?: string) => {
    const clash = ctx.blocks.find((b) => {
      const o = { start: localMinutes(b.start_utc, tz), end: localMinutes(b.end_utc, tz) };
      return interval.start < o.end && o.start < interval.end;
    });
    if (!clash) { return; }
    structural = true;
    violations.push({
      task_key: block.task_key,
      constraint_id: constraintId,
      reason: `「${block.title}」与「${clash.title}」时间重叠（${ctx.day}）`,
      suggestion: '调整其中一个事件的时间，固定事件不会被自动移动',
    });
  };

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

  for (const c of constraints) {
    if (c.payload.type !== 'fixed_block') continue;
    const p = c.payload;
    const sameTitle = tasksByTitle.get(p.title.trim()) ?? [];
    const linked = sameTitle.length === 1 ? sameTitle[0] : undefined;
    for (const ctx of ctxByDay.values()) {
      const hit = p.date !== undefined ? p.date === ctx.day : p.weekday === ctx.weekday;
      if (!hit) continue;
      const interval = { start: hhmmToMin(p.start), end: hhmmToMin(p.end) };
      const startUtc = utcAt(ctx.day, interval.start, tz);
      // Skip expired new fixed events without changing supplied pins or history.
      if (pastDays.has(ctx.day) || (now_ms !== undefined && Date.parse(startUtc) < now_ms)) {
        compromises.push({ constraint_id: c.id, ...(linked ? { task_key: linked.key } : {}), reason: `${ctx.day}「${p.title}」开始时间已过去，未新增固定安排` });
        continue;
      }
      const fixedBlock: Block = {
        id: nextId(), title: p.title, category: p.category,
        ...(linked ? { task_key: linked.key } : {}),
        start_utc: startUtc, end_utc: utcAt(ctx.day, interval.end, tz),
        priority: 'high', pinned: true, origin: 'fixed',
      };
      const busyClash = busyCons.find(b => {
        if (b.payload.type !== 'busy_window') return false;
        const p = b.payload;
        return (p.date !== undefined ? p.date === ctx.day : p.weekday === ctx.weekday)
          && interval.start < hhmmToMin(p.end) && hhmmToMin(p.start) < interval.end
          && !(p.label === fixedBlock.title && p.start === minToHHmm(interval.start) && p.end === minToHHmm(interval.end));
      });
      if (busyClash) violations.push({ constraint_id: c.id, ...(linked ? { task_key: linked.key } : {}), reason: `${ctx.day}「${p.title}」与「${busyClash.payload.type === 'busy_window' ? busyClash.payload.label ?? '已有占用' : '已有占用'}」冲突`, suggestion: '请先确认调整哪项安排，不能同时执行' });
      assertNoOverlap(ctx, fixedBlock, interval, c.id);
      registerBlock(ctx, fixedBlock, interval);
      // 同名任务已在固定时段落位：计入完成量，避免再排一次同样的任务。
      if (linked) {
        const entry = pinnedByTask.get(linked.key) ?? { count: 0, days: new Set<string>() };
        entry.count += 1;
        entry.days.add(ctx.day);
        pinnedByTask.set(linked.key, entry);
      }
    }
  }

  for (const pinned of input.pinned_blocks) {
    const day = localDay(pinned.start_utc, tz);
    const ctx = ctxByDay.get(day);
    if (!ctx) continue;
    const interval = { start: localMinutes(pinned.start_utc, tz), end: localMinutes(pinned.end_utc, tz) };
    const pinnedBlock = { ...pinned };
    assertNoOverlap(ctx, pinnedBlock, interval);
    registerBlock(ctx, pinnedBlock, interval);
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

  const freeSlots = (ctx: DayContext, minSize = MIN_FRAGMENT_MIN, pref?: PeriodPref): Interval[] => {
    const cuts = [...ctx.busy];
    for (const occ of ctx.occupied) {
      cuts.push({ start: occ.start - bufferMin, end: occ.end + bufferMin });
    }
    // 用户用约束 start/end 明确声明的精确窗口 = 该任务的硬可用窗口（正文承诺几点就几点），仍受作息保护；
    // 无显式 active_window 时窗口可早于默认作息起点，有显式 active_window 时取交集。
    let active = ctx.active;
    if (pref?.custom) {
      const w = { start: Math.max(pref.bounds[0], QUIET_END), end: Math.min(pref.bounds[1], QUIET_START) };
      const base = ctx.hasActiveCons ? ctx.active : [{ start: QUIET_END, end: QUIET_START }];
      active = base.map((iv) => ({ start: Math.max(iv.start, w.start), end: Math.min(iv.end, w.end) })).filter((iv) => iv.end > iv.start);
    }
    return subtractIntervals(active, cuts).filter((s) => s.end - s.start >= minSize);
  };

  const periodScore = (pref: PeriodPref | undefined, interval: Interval): number => {
    if (!pref) return 0;
    const [ps, pe] = pref.bounds;
    const overlap = Math.max(0, Math.min(interval.end, pe) - Math.max(interval.start, ps));
    return overlap >= (interval.end - interval.start) * 0.8 ? 0 : 1;
  };

  // 早于常见作息起点的分钟数罚分：不改变日期优先与偏好时段优先，只压掉「贴窗口起点」的凌晨/清晨落位。
  const earlyPenalty = (start: number) => Math.max(0, PREFERRED_DAY_START - start) * 10;

  const candidateIntervals = (ctx: DayContext, slot: Interval, task: TaskDef, candidate: { task_key?: string; category: string }, pref: PeriodPref | undefined): Interval[] => {
    const starts = new Set<number>([slot.start]);
    // 常见作息起点也是候选：可用时段从 06:00 开始时，07:00 优先于 06:00。
    if (PREFERRED_DAY_START > slot.start && PREFERRED_DAY_START < slot.end) starts.add(PREFERRED_DAY_START);
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
    if (pref) {
      const ps = pref.bounds[0];
      if (ps > slot.start && ps < slot.end) starts.add(ps);
    }
    const out: Interval[] = [];
    for (const s of [...starts].sort((a, b) => a - b)) {
      const avail = slot.end - s;
      if (!task.splittable && avail < task.duration_min) continue;
      if (task.splittable && avail < minPlacement(task.duration_min)) continue;
      // 每日上限是硬约束：单个块不得超过当天剩余额度（拆分任务按剩余额度切片）。
      const capLeft = capFor(ctx.day, task.category);
      const length = task.splittable ? Math.min(avail, task.duration_min, capLeft) : Math.min(avail, task.duration_min);
      if (task.splittable && length < MIN_FRAGMENT_MIN && length < task.duration_min) continue;
      out.push({ start: s, end: s + length });
    }
    // 拆分补位按此顺序取首个可行候选：越接近常见作息起点越优先。
    out.sort((a, b) => (earlyPenalty(a.start) + a.start) - (earlyPenalty(b.start) + b.start));
    return out;
  };

  // 任务级依赖：循环检测 + 拓扑顺序（前置任务先落位）；有环的任务不排并给出结构性违例。
  const depMap = new Map<string, string[]>();
  const unknownDeps = new Map<string, string[]>();
  for (const t of input.task_defs) {
    const unknown = (t.depends_on ?? []).filter((k) => k !== t.key && !taskByKey.has(k));
    if (unknown.length) unknownDeps.set(t.key, unknown);
    const deps = (t.depends_on ?? []).filter((k) => k !== t.key && taskByKey.has(k));
    if (deps.length) depMap.set(t.key, deps);
  }
  const cyclic = new Set<string>();
  {
    const state = new Map<string, 0 | 1 | 2>();
    const visit = (k: string) => {
      const st = state.get(k) ?? 0;
      if (st === 1) { cyclic.add(k); return; }
      if (st === 2) return;
      state.set(k, 1);
      for (const d of depMap.get(k) ?? []) visit(d);
      state.set(k, 2);
    };
    for (const k of depMap.keys()) visit(k);
  }
  for (const k of cyclic) {
    const t = taskByKey.get(k)!;
    structural = true;
    violations.push({ task_key: k, reason: `「${t.title}」存在循环依赖，无法安排`, suggestion: '移除依赖环中的一条依赖后重试' });
  }
  const taskRank = (a: TaskDef, b: TaskDef) => {
    const ad = a.deadline ?? '9999-99-99';
    const bd = b.deadline ?? '9999-99-99';
    if (ad !== bd) return ad.localeCompare(bd);
    const pw = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    if (pw !== 0) return pw;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.key.localeCompare(b.key);
  };
  const sortedTasks: TaskDef[] = [];
  {
    const seen = new Set<string>();
    const visitTask = (t: TaskDef) => {
      if (seen.has(t.key) || cyclic.has(t.key)) return;
      seen.add(t.key);
      for (const d of depMap.get(t.key) ?? []) {
        const dt = taskByKey.get(d);
        if (dt) visitTask(dt);
      }
      sortedTasks.push(t);
    };
    for (const t of [...input.task_defs].sort(taskRank)) visitTask(t);
  }

  const makeBlock = (task: TaskDef, ctx: DayContext, interval: Interval): Block => ({
    id: nextId(), task_key: task.key, title: task.title, category: task.category,
    start_utc: utcAt(ctx.day, interval.start, tz), end_utc: utcAt(ctx.day, interval.end, tz),
    priority: task.priority, pinned: false, origin: 'engine',
    ...(task.notes ? { notes: task.notes } : {}),
  });

  const recordSoft = (task: TaskDef, block: Block, ctx: DayContext, interval: Interval) => {
    const pref = preferredPeriodFor(task, constraints);
    if (pref && periodScore(pref, interval) === 1) {
      compromises.push({ block_id: block.id, task_key: task.key, reason: `「${task.title}」未落在偏好的${pref.period === 'morning' ? '早晨' : pref.period === 'afternoon' ? '下午' : pref.period === 'evening' ? '傍晚' : '夜间'}时段` });
    }
    const rule = mutexConflict(ctx, block, interval);
    if (rule && rule.strength === 'soft') {
      compromises.push({ block_id: block.id, task_key: task.key, constraint_id: rule.id, reason: `「${task.title}」与互斥任务同日相邻或共存（软约束妥协）` });
    }
  };

  const scopedDaysOf = (t: TaskDef): string[] | null => {
    if (!t.earliest_start && !t.deadline) return null;
    return days.filter((d) => (!t.earliest_start || d >= t.earliest_start) && (!t.deadline || d <= t.deadline));
  };
  // Historical pins count toward the quota but cannot consume future occurrences.
  const unavailableDayFor = (t: TaskDef, day: string) => blockedDays.has(day) || (pastDays.has(day) && !pinnedByTask.get(t.key)?.days.has(day));
  const targetCountFor = (t: TaskDef): number => {
    const scoped = scopedDaysOf(t);
    if (t.frequency.type === 'once') return scoped ? (scoped.length ? 1 : 0) : 1;
    // 全天被占用的日子不计入目标量：旅行/考试日跳过是承诺的一部分，不是「放不下」。
    if (t.frequency.type === 'daily') return (scoped ?? days).filter((d) => !unavailableDayFor(t, d)).length;
    const { count } = t.frequency;
    let target = 0;
    for (let i = 0; i < days.length; i += 7) {
      const seg = days.slice(i, i + 7);
      const quota = seg.length === 7 ? count : Math.max(1, Math.round((count * seg.length) / 7));
      const blockedHere = seg.filter((d) => unavailableDayFor(t, d)).length;
      target += blockedHere ? Math.min(quota, seg.length - blockedHere) : quota;
    }
    return target;
  };

  for (const task of sortedTasks) {
    const pre = pinnedByTask.get(task.key);
    let placedCount = pre?.count ?? 0;
    const usedDays = new Set<string>(pre?.days ?? []);
    const pref = preferredPeriodFor(task, constraints);
    const candidate = { task_key: task.key, category: task.category };

    const scoped = scopedDaysOf(task);
    const window = scoped ? new Set(scoped) : null;
    if (window && window.size === 0) {
      structural = true;
      targetMinutes.set(task.key, 0);
      violations.push({ task_key: task.key, reason: `「${task.title}」的日期范围为空（最早开始晚于截止日）`, suggestion: '检查任务的最早开始与截止日期' });
      continue;
    }
    const unknownList = unknownDeps.get(task.key);
    if (unknownList) {
      structural = true;
      targetMinutes.set(task.key, targetCountFor(task) * task.duration_min);
      violations.push({ task_key: task.key, reason: `「${task.title}」依赖了不存在的任务「${unknownList.join('、')}」`, suggestion: '删除或更正 depends_on 中的任务 key' });
      continue;
    }
    const deps = depMap.get(task.key) ?? [];
    const unmet = deps.filter((d) => {
      const depTask = taskByKey.get(d)!;
      const depTarget = targetCountFor(depTask) * depTask.duration_min;
      return (runningMinutes.get(d) ?? 0) < depTarget;
    });
    if (unmet.length) {
      targetMinutes.set(task.key, targetCountFor(task) * task.duration_min);
      violations.push({ task_key: task.key, reason: `「${task.title}」的前置任务「${unmet.map((k) => taskByKey.get(k)!.title).join('、')}」尚未排完`, suggestion: '先放宽前置任务的容量或调整其截止日' });
      continue;
    }
    // 依赖条件 = 所有前置块的最晚结束时间 + 最小间隔（buffer 约束，缺省 0）。
    let depReadyUtc: string | null = null;
    for (const d of deps) {
      const end = lastEndByKey.get(d);
      if (!end) continue;
      const withGap = new Date(Date.parse(end) + bufferMin * 60000).toISOString();
      if (!depReadyUtc || withGap > depReadyUtc) depReadyUtc = withGap;
    }
    const depReadyDay = depReadyUtc ? localDay(depReadyUtc, tz) : null;
    const dayAllowed = (day: string) => !pastDays.has(day) && (!window || window.has(day)) && (!depReadyDay || day >= depReadyDay);
    const startAllowed = (day: string, startMin: number) => {
      if (now_ms === undefined && !depReadyUtc) return true;
      const startMs = Date.parse(utcAt(day, startMin, tz));
      // Also compare instants: repeated local hours at DST fallback can map to an earlier instant.
      return (now_ms === undefined || startMs >= now_ms) && (!depReadyUtc || startMs >= Date.parse(depReadyUtc));
    };

    /** 在允许的日期里落一次；允许集合为空表示整个 horizon。 */
    const placeOne = (allowed?: Set<string>): boolean => {
      const bestRef: { current: { ctx: DayContext; interval: Interval; score: number } | null } = { current: null };
      for (const ctx of ctxByDay.values()) {
        if (allowed && !allowed.has(ctx.day)) continue;
        if (!dayAllowed(ctx.day)) continue;
        if (usedDays.has(ctx.day)) continue;
        if (blockedDays.has(ctx.day)) continue;
        if (capFor(ctx.day, task.category) < (task.splittable ? minPlacement(task.duration_min) : task.duration_min)) continue;
        for (const slot of freeSlots(ctx, minPlacement(task.duration_min), pref)) {
          for (const interval of candidateIntervals(ctx, slot, task, candidate, pref)) {
            if (!startAllowed(ctx.day, interval.start)) continue;
            const conflict = mutexConflict(ctx, candidate, interval);
            if (conflict && conflict.strength === 'hard') continue;
            const softPenalty = conflict ? 100000 : 0;
            // 同日内整块优先于早起的碎片：能一次排完就不拆分。
            const splitPenalty = task.splittable && interval.end - interval.start < task.duration_min ? 5000 : 0;
            const score = periodScore(pref, interval) * 1000000 + softPenalty + days.indexOf(ctx.day) * 10000 + splitPenalty + earlyPenalty(interval.start) + interval.start;
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
        while (splitMinutesLeft > 0) {
          let frag: { ctx: DayContext; interval: Interval } | null = null;
          const fragTask = { ...task, duration_min: splitMinutesLeft };
          // 拆分补位同日优先；daily 任务的剩余部分只允许落在当天，
          // 否则会把别的日子的配额偷走（单日超量、其他日缺量）。
          const fragDays = task.frequency.type === 'daily'
            ? [ctx]
            : [ctx, ...[...ctxByDay.values()].filter((d) => d !== ctx && !usedDays.has(d.day))];
          for (const fctx of fragDays) {
            if (allowed && !allowed.has(fctx.day)) continue;
            if (!dayAllowed(fctx.day)) continue;
            if (blockedDays.has(fctx.day)) continue;
            if (capFor(fctx.day, task.category) < minPlacement(splitMinutesLeft)) continue;
            let bestClean: { interval: Interval; score: number } | null = null;
            let bestSoft: { interval: Interval; score: number } | null = null;
            for (const slot of freeSlots(fctx, minPlacement(splitMinutesLeft), pref)) {
              for (const fi of candidateIntervals(fctx, slot, fragTask, candidate, pref)) {
                if (fi.end - fi.start < MIN_FRAGMENT_MIN && fi.end - fi.start < splitMinutesLeft) continue;
                if (!startAllowed(fctx.day, fi.start)) continue;
                const conflict = mutexConflict(fctx, candidate, fi);
                if (conflict && conflict.strength === 'hard') continue;
                const score = periodScore(pref, fi) * 1000000 + earlyPenalty(fi.start) + fi.start;
                if (!conflict) { if (!bestClean || score < bestClean.score) bestClean = { interval: fi, score }; }
                else if (!bestSoft || score < bestSoft.score) bestSoft = { interval: fi, score };
              }
            }
            const chosen = bestClean ?? bestSoft;
            if (chosen) { frag = { ctx: fctx, interval: chosen.interval }; break; }
          }
          if (!frag) break;
          const fb = makeBlock(task, frag.ctx, frag.interval);
          registerBlock(frag.ctx, fb, frag.interval);
          usedDays.add(frag.ctx.day);
          recordSoft(task, fb, frag.ctx, frag.interval);
          splitMinutesLeft -= frag.interval.end - frag.interval.start;
        }
        if (splitMinutesLeft > 0) {
          if (ctx.day === nowPastDay) {
            compromises.push({ reason: `今天剩余时段放不下「${task.title}」剩余的 ${splitMinutesLeft} 分钟，已安排能放下的部分` });
          } else {
            violations.push({ task_key: task.key, reason: `「${task.title}」拆分后仍有 ${splitMinutesLeft} 分钟无法落位${task.frequency.type === 'daily' ? '（当天剩余时段放不下）' : ''}`, suggestion: '放宽每日上限或增加可用时段' });
          }
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
        const rawQuota = seg.length === 7 ? count : Math.max(1, Math.round((count * seg.length) / 7));
        const blockedHere = seg.filter((d) => unavailableDayFor(task, d)).length;
        const quota = blockedHere ? Math.min(rawQuota, seg.length - blockedHere) : rawQuota;
        target += quota;
        const allowed = new Set(seg);
        const pinnedHere = [...(pre?.days ?? [])].filter((d) => allowed.has(d)).length;
        let need = Math.max(0, quota - pinnedHere);
        while (need > 0 && placeOne(allowed)) { placedCount += 1; need -= 1; }
      }
    } else {
      target = targetCountFor(task);
      while (placedCount < target && placeOne()) placedCount += 1;
    }
    // 今天已过去的时间不算容量缺口：当日剩余放不下而跳过今天时，用妥协说明而不是报「排不下」。
    if (placedCount < target && nowPastDay && !usedDays.has(nowPastDay) && !blockedDays.has(nowPastDay) && dayAllowed(nowPastDay)) {
      target -= 1;
      compromises.push({ reason: `今天剩余时段已放不下「${task.title}」，今天先跳过` });
    }
    targetMinutes.set(task.key, target * task.duration_min);

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
  const placedByKey = new Map<string, number>();
  let scheduledMinutes = 0;
  for (const b of outputBlocks) {
    const minutes = Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000);
    if (b.origin !== 'fixed') scheduledMinutes += minutes;
    if (!b.task_key) continue;
    placedByKey.set(b.task_key, (placedByKey.get(b.task_key) ?? 0) + minutes);
  }
  const unplaced: UnplacedWork[] = [];
  for (const t of input.task_defs) {
    const target = targetMinutes.get(t.key) ?? t.duration_min;
    const done = placedByKey.get(t.key) ?? 0;
    if (done >= target) continue;
    const detail = violations.find((v) => v.task_key === t.key);
    unplaced.push({
      task_key: t.key,
      title: t.title,
      target_minutes: target,
      placed_minutes: done,
      missing_minutes: target - done,
      reason: detail?.reason ?? '可用时段不足',
    });
  }
  // 只有结构性矛盾（循环依赖、固定事件重叠、硬互斥矛盾、日期窗为空）才是 INFEASIBLE 的证明；
  // 贪心排不下只是 PARTIAL/UNKNOWN，不能谎称不可行。
  const feasibility: Feasibility = violations.length === 0
    ? 'FEASIBLE'
    : structural
      ? 'INFEASIBLE'
      : scheduledMinutes > 0 || outputBlocks.length > 0
        ? 'PARTIAL'
        : 'UNKNOWN';
  const placed = outputBlocks.filter((b) => b.origin === 'engine').length;
  return {
    blocks: outputBlocks,
    violations,
    compromises,
    feasibility,
    unplaced,
    stats: { placed, unplaced: unplaced.length, solve_ms: 0 },
  };
}