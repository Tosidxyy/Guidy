import { z } from '../vendor/zod.ts';

export const CategoryEnum = z.enum([
  'study', 'fitness', 'reading', 'work', 'life', 'creative', 'rest', 'other',
]);
export const PriorityEnum = z.enum(['high', 'mid', 'low']);
export const PeriodEnum = z.enum(['morning', 'afternoon', 'evening', 'night']);
export const HorizonDaysSchema = z.number().int().min(1).max(365);
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
  /** 执行细节/资料要点，会随生成的时间块进入日历与上下文。 */
  notes: z.string().max(500).optional(),
  /** 任务级截止日（含当天），本任务的所有时间块必须完成于此日之前。 */
  deadline: z.string().date().optional(),
  /** 任务级最早开始日（含当天）。 */
  earliest_start: z.string().date().optional(),
  /** 前置依赖：这些任务全部落位（或已完成）后才能安排本任务。 */
  depends_on: z.array(z.string()).max(8).optional(),
});

export const BlockStatusEnum = z.enum(['planned', 'in_progress', 'completed', 'partial', 'cancelled', 'skipped']);
export type BlockStatus = z.infer<typeof BlockStatusEnum>;

const progressFields = {
  status: BlockStatusEnum.optional(),
  completed_at: z.string().datetime().nullable().optional(),
  actual_duration_min: z.number().int().min(0).max(1440).nullable().optional(),
  progress_updated_at: z.string().datetime().nullable().optional(),
};

// update_task_def 的 patch：可选字段可以传 null 清除（例如 preferred_period）。
export const TaskDefPatchSchema = TaskDefSchema.partial().extend({
  preferred_period: PeriodEnum.nullable().optional(),
});

const weekdayOrDate = { weekday: Weekday.optional(), date: z.string().date().optional() };
const exactlyOneAnchor = (c: { weekday?: number; date?: string }) =>
  (c.weekday === undefined) !== (c.date === undefined);

export const ConstraintPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('busy_window'), ...weekdayOrDate, start: HHmm, end: HHmm, label: z.string().max(30).optional() }),
  z.object({ type: z.literal('active_window'), start: HHmm, end: HHmm, weekdays: z.array(Weekday).min(1).optional(), include_quiet: z.boolean().optional() }),
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
    /** 精确时段覆盖：用户说「19点以后」这类与 period 边界不一致的窗口时用 start/end 表达。 */
    start: HHmm.optional(),
    end: HHmm.optional(),
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
  if (val.type === 'preferred_period' && val.start && val.end && hhmmOrderInvalid(val.start, val.end)) {
    issue('结束时间必须晚于开始时间');
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
  recurrence_weekday: z.number().int().min(0).max(6).optional(),
  unavailable_date: z.string().date().optional(),
  // 仅用于撤销恢复原块语义：engine 块会被重排替换，manual 块作为固定保留。
  origin: z.enum(['engine', 'manual', 'fixed']).optional(),
  task_key: z.string().optional(),
  ...progressFields,
});

export const PlanBlockSchema = z.object({
  id: z.string().min(1).max(64),
  task_key: z.string().optional(),
  title: z.string().min(1).max(60),
  category: CategoryEnum,
  start_utc: z.string().datetime(),
  end_utc: z.string().datetime(),
  priority: PriorityEnum,
  pinned: z.boolean(),
  origin: z.enum(['engine', 'manual', 'fixed']),
  notes: z.string().max(500).optional(),
  recurrence_weekday: z.number().int().min(0).max(6).optional(),
  unavailable_date: z.string().date().optional(),
  ...progressFields,
}).refine((b) => Date.parse(b.end_utc) > Date.parse(b.start_utc), '结束时间必须晚于开始时间');

export const ProgressUpdateSchema = z.object({
  status: BlockStatusEnum,
  actual_duration_min: z.number().int().min(0).max(1440).nullable().optional(),
});

export const PatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_task_def'), value: TaskDefSchema }),
  z.object({ op: z.literal('update_task_def'), key: z.string(), patch: TaskDefPatchSchema }),
  z.object({ op: z.literal('remove_task_def'), key: z.string() }),
  z.object({
    op: z.literal('add_constraint'),
    value: ConstraintPayloadSchema,
    client_id: z.string().uuid().optional(),
    source: z.enum(['user', 'ai', 'template']).optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('update_constraint'),
    id: z.string(),
    patch: z.object({
      payload: ConstraintPayloadSchema.optional(),
      enabled: z.boolean().optional(),
      source: z.enum(['user', 'ai', 'template']).optional(),
    }),
  }),
  z.object({ op: z.literal('remove_constraint'), id: z.string() }),
  z.object({ op: z.literal('add_block'), value: ManualBlockSchema, client_id: z.string().uuid().optional(), plan_id: z.string().uuid().optional() }),
  // 块操作带语义定位（task_key/date/title）：AI 引用过期 id 时可按「哪个任务的哪一天」校正。
  z.object({ op: z.literal('update_block'), id: z.string(), patch: ManualBlockSchema.partial(), task_key: z.string().optional(), date: z.string().optional(), title: z.string().optional(), allow_overlap: z.boolean().optional() }),
  z.object({ op: z.literal('move_block'), id: z.string(), start_utc: z.string().datetime(), end_utc: z.string().datetime(), task_key: z.string().optional(), date: z.string().optional(), title: z.string().optional(), origin: z.enum(['engine', 'manual', 'fixed']).optional(), recurrence_weekday: z.number().int().min(0).max(6).optional(), unavailable_date: z.string().date().optional() }),
  z.object({ op: z.literal('remove_block'), id: z.string(), task_key: z.string().optional(), date: z.string().optional(), title: z.string().optional() }),
  z.object({ op: z.literal('reschedule'), scope: z.enum(['affected_only', 'all']).default('affected_only'), keep_pinned: z.literal(true) }),
  z.object({ op: z.literal('clear_plan') }),
]);

// 计划元数据：人工编辑、撤销与 AI 都能发起；plan_id 缺省表示当前计划。
export const UpdatePlanOpSchema = z.object({
  op: z.literal('update_plan'),
  plan_id: z.string().uuid().optional(),
  patch: z
    .object({
      title: z.string().min(1).max(60).optional(),
      horizon_start: z.string().date().optional(),
      horizon_days: HorizonDaysSchema.optional(),
      timezone: z.string().min(1).max(64).optional(),
    })
    .refine((p) => Object.keys(p).length > 0, '至少修改一个字段'),
});

export const ApplyOpSchema = z.union([PatchOpSchema, UpdatePlanOpSchema]);

// 信息不足时的追问卡片：不进计划，只把问题结构化地呈现给用户。
export const QuestionCardArtifactSchema = z.object({
  type: z.literal('question_card'),
  title: z.string().max(40).optional(),
  questions: z
    .array(
      z.object({
        text: z.string().min(1).max(140),
        options: z.array(z.string().min(1).max(40)).min(2).max(4).optional(),
      }),
    )
    .min(1)
    .max(3),
});

export const PatchArtifactSchema = z.object({
  type: z.literal('patch'),
  summary: z.string().max(200),
  ops: z.array(ApplyOpSchema).min(1).max(30),
});

export const ConstraintSetArtifactSchema = z.object({
  type: z.literal('constraint_set'),
  plan_title: z.string().max(60),
  horizon_start: z.string().date().optional(),
  horizon_days: HorizonDaysSchema.default(7),
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
export type ApplyOp = z.infer<typeof ApplyOpSchema>;
export type PatchArtifact = z.infer<typeof PatchArtifactSchema>;
export type ConstraintSetArtifact = z.infer<typeof ConstraintSetArtifactSchema>;
export type QuestionCardArtifact = z.infer<typeof QuestionCardArtifactSchema>;