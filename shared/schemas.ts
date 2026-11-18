import { z } from 'npm:zod@3.25.76';

export const CategoryEnum = z.enum([
  'study', 'fitness', 'reading', 'work', 'life', 'creative', 'rest', 'other',
]);
export const PriorityEnum = z.enum(['high', 'mid', 'low']);
export const PeriodEnum = z.enum(['morning', 'afternoon', 'evening', 'night']);
export const HHmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式须为 HH:mm');
export const Weekday = z.number().int().min(0).max(6);

export const FrequencySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('per_week'), count: z.number().int().min(1).max(14) }),
  z.object({ type: z.literal('daily') }),
  z.object({ type: z.literal('once') }),
]);

export const TaskDefSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,24}$/),
  title: z.string().min(1).max(60),
  category: CategoryEnum,
  duration_min: z.number().int().min(5).max(480),
  frequency: FrequencySchema,
  priority: PriorityEnum.default('mid'),
  splittable: z.boolean().default(false),
  preferred_period: PeriodEnum.optional(),
  sort_order: z.number().int().default(0),
});

const weekdayOrDate = { weekday: Weekday.optional(), date: z.string().date().optional() };
const exactlyOneAnchor = (c: { weekday?: number; date?: string }) =>
  (c.weekday === undefined) !== (c.date === undefined);

export const ConstraintPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('busy_window'), ...weekdayOrDate, start: HHmm, end: HHmm, label: z.string().max(30).optional() }),
  z.object({ type: z.literal('active_window'), start: HHmm, end: HHmm, weekdays: z.array(Weekday).min(1).optional() }),
  z.object({ type: z.literal('daily_cap'), category: CategoryEnum, max_minutes: z.number().int().min(30).max(960) }),
  z.object({
    type: z.literal('mutex'),
    subjects: z.object({ kind: z.enum(['category', 'task']), values: z.array(z.string()).length(2) }),
    mode: z.enum(['no_adjacent', 'no_same_day']),
    strength: z.enum(['soft', 'hard']).default('soft'),
  }),
  z.object({
    type: z.literal('preferred_period'),
    task_key: z.string().optional(),
    category: CategoryEnum.optional(),
    period: PeriodEnum,
    strength: z.literal('soft').default('soft'),
  }),
  z.object({ type: z.literal('buffer'), minutes: z.number().int().min(0).max(120) }),
  z.object({ type: z.literal('fixed_block'), title: z.string().max(60), category: CategoryEnum, ...weekdayOrDate, start: HHmm, end: HHmm }),
  z.object({ type: z.literal('deadline'), date: z.string().date(), label: z.string().max(30) }),
]).superRefine((val, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (val.type === 'busy_window' || val.type === 'fixed_block') {
    if (!exactlyOneAnchor(val)) issue('weekday 与 date 必须二选一');
    if (hhmmOrderInvalid(val.start, val.end)) issue('结束时间必须晚于开始时间');
  }
  if (val.type === 'active_window' && hhmmOrderInvalid(val.start, val.end)) issue('结束时间必须晚于开始时间');
  if (val.type === 'mutex' && val.subjects.values[0] === val.subjects.values[1]) issue('互斥主体必须不同');
  if (val.type === 'preferred_period' && (val.task_key === undefined) === (val.category === undefined)) {
    issue('task_key 与 category 必须二选一');
  }
});

function hhmmOrderInvalid(start: string, end: string): boolean {
  return end <= start;
}

export const ConstraintSchema = z.object({
  id: z.string().min(1),
  payload: ConstraintPayloadSchema,
  source: z.enum(['user', 'ai', 'template']).default('user'),
  enabled: z.boolean().default(true),
});

export const ManualBlockSchema = z.object({
  title: z.string().min(1).max(60),
  category: CategoryEnum,
  start_utc: z.string().datetime(),
  end_utc: z.string().datetime(),
  priority: PriorityEnum.default('mid'),
  pinned: z.boolean().default(false),
  notes: z.string().max(500).optional(),
});

export const PatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_task_def'), value: TaskDefSchema }),
  z.object({ op: z.literal('update_task_def'), key: z.string(), patch: TaskDefSchema.partial() }),
  z.object({ op: z.literal('remove_task_def'), key: z.string() }),
  z.object({ op: z.literal('add_constraint'), value: ConstraintPayloadSchema }),
  z.object({ op: z.literal('update_constraint'), id: z.string(), patch: z.record(z.unknown()) }),
  z.object({ op: z.literal('remove_constraint'), id: z.string() }),
  z.object({ op: z.literal('add_block'), value: ManualBlockSchema }),
  z.object({ op: z.literal('update_block'), id: z.string(), patch: ManualBlockSchema.partial() }),
  z.object({ op: z.literal('move_block'), id: z.string(), start_utc: z.string().datetime(), end_utc: z.string().datetime() }),
  z.object({ op: z.literal('remove_block'), id: z.string() }),
  z.object({ op: z.literal('reschedule'), scope: z.enum(['affected_only', 'all']).default('affected_only'), keep_pinned: z.literal(true) }),
  z.object({ op: z.literal('clear_plan') }),
]);

export const PatchArtifactSchema = z.object({
  type: z.literal('patch'),
  summary: z.string().max(200),
  ops: z.array(PatchOpSchema).min(1).max(30),
});

export const ConstraintSetArtifactSchema = z.object({
  type: z.literal('constraint_set'),
  plan_title: z.string().max(60),
  horizon_start: z.string().date().optional(),
  horizon_days: z.union([z.literal(7), z.literal(14)]).default(7),
  task_defs: z.array(TaskDefSchema).min(1).max(30),
  constraints: z.array(ConstraintPayloadSchema).max(40),
  clarifications_needed: z.array(z.string().max(200)).max(2),
});

export type Category = z.infer<typeof CategoryEnum>;
export type Priority = z.infer<typeof PriorityEnum>;
export type Period = z.infer<typeof PeriodEnum>;
export type Frequency = z.infer<typeof FrequencySchema>;
export type TaskDef = z.infer<typeof TaskDefSchema>;
export type ConstraintPayload = z.infer<typeof ConstraintPayloadSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type ManualBlock = z.infer<typeof ManualBlockSchema>;
export type PatchOp = z.infer<typeof PatchOpSchema>;
export type PatchArtifact = z.infer<typeof PatchArtifactSchema>;
export type ConstraintSetArtifact = z.infer<typeof ConstraintSetArtifactSchema>;