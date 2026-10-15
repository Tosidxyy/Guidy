import { AgentError } from "./provider.ts";

type DraftTask = {
  key: string;
  stage: number;
  title: string;
  instructions: string;
  duration_minutes: number;
  frequency_per_week: number;
  mandatory: boolean;
  depends_on: string[];
  evidence_ids: string[];
};
type ModelDraft = {
  time_preferences?: {
    timezone: "Asia/Shanghai" | "UTC";
    start_minute: number;
    end_minute: number;
    excluded_weekdays: number[];
  };
  stage_weeks?: { stage: number; weeks: number }[];
  title: string;
  summary: string;
  assumptions: string[];
  risks: string[];
  tasks: DraftTask[];
};
export function checkedPlan(
  content: string,
  sourceIds: string[],
  allowUncited = false,
) {
  const fail = (code = "PLAN_SCHEMA_JSON") => {
    throw new AgentError(code);
  };
  let v: ModelDraft;
  try {
    v = JSON.parse(content);
  } catch {
    return fail();
  }
  const text = (s: unknown, max: number) =>
    typeof s === "string" && !!s.trim() && s.length <= max;
  const list = (x: unknown) =>
    Array.isArray(x) && x.length <= 5 && x.every((s) => text(s, 160));
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail("PLAN_SCHEMA_OBJECT");
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "title",
          "summary",
          "assumptions",
          "risks",
          "tasks",
          "stage_weeks",
          "time_preferences",
        ].includes(k),
    )
  )
    fail("PLAN_SCHEMA_FIELDS");
  if (!text(v.title, 80)) fail("PLAN_SCHEMA_TITLE");
  const p = v.time_preferences;
  if (
    p !== undefined &&
    (!p ||
      Object.keys(p).sort().join(",") !==
        "end_minute,excluded_weekdays,start_minute,timezone" ||
      !["UTC", "Asia/Shanghai"].includes(p.timezone) ||
      !Number.isInteger(p.start_minute) ||
      !Number.isInteger(p.end_minute) ||
      p.start_minute < 0 ||
      p.end_minute > 1440 ||
      p.end_minute - p.start_minute < 5 ||
      !Array.isArray(p.excluded_weekdays) ||
      p.excluded_weekdays.length > 7 ||
      new Set(p.excluded_weekdays).size !== p.excluded_weekdays.length ||
      p.excluded_weekdays.some((n) => !Number.isInteger(n) || n < 0 || n > 6))
  )
    fail("PLAN_SCHEMA_FIELDS");
  if (!text(v.summary, 300)) fail("PLAN_SCHEMA_SUMMARY");
  if (!list(v.assumptions)) fail("PLAN_SCHEMA_ASSUMPTIONS");
  if (!list(v.risks)) fail("PLAN_SCHEMA_RISKS");
  if (!Array.isArray(v.tasks) || v.tasks.length < 1 || v.tasks.length > 6)
    fail("PLAN_SCHEMA_TASKS");
  const keys = new Set(v.tasks.map((t) => t?.key));
  if (keys.size !== v.tasks.length) fail("PLAN_SCHEMA_KEYS");
  for (const t of v.tasks) {
    if (
      !t ||
      Object.keys(t).some(
        (k) =>
          ![
            "key",
            "stage",
            "title",
            "instructions",
            "duration_minutes",
            "frequency_per_week",
            "mandatory",
            "depends_on",
            "evidence_ids",
          ].includes(k),
      ) ||
      !/^t[1-6]$/.test(t.key) ||
      !text(t.title, 80) ||
      !text(t.instructions, 400) ||
      !Number.isInteger(t.stage) ||
      t.stage < 1 ||
      t.stage > 3 ||
      !Number.isInteger(t.duration_minutes) ||
      t.duration_minutes < 5 ||
      t.duration_minutes > 120 ||
      !Number.isInteger(t.frequency_per_week) ||
      t.frequency_per_week < 1 ||
      t.frequency_per_week > 7 ||
      typeof t.mandatory !== "boolean" ||
      !Array.isArray(t.depends_on) ||
      t.depends_on.length > 5 ||
      new Set(t.depends_on).size !== t.depends_on.length ||
      !Array.isArray(t.evidence_ids) ||
      t.evidence_ids.length > 3 ||
      new Set(t.evidence_ids).size !== t.evidence_ids.length
    )
      fail("PLAN_INVALID_TASK");
    if (t.depends_on.some((k) => k === t.key || !keys.has(k)))
      fail("PLAN_INVALID_DEPENDENCY");
    if (t.evidence_ids.some((id) => !sourceIds.includes(id)))
      fail("PLAN_INVALID_CITATION");
  }
  if (
    !v.tasks.some((t) => t.evidence_ids.length) &&
    !(allowUncited && sourceIds.length === 0)
  )
    fail("PLAN_INVALID_CITATION");
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) fail("PLAN_INVALID_DEPENDENCY");
    if (done.has(key)) return;
    visiting.add(key);
    const task = v.tasks.find((t) => t.key === key)!;
    for (const dependency of task.depends_on) {
      const parent = v.tasks.find((t) => t.key === dependency)!;
      if (parent.stage > task.stage) fail("PLAN_INVALID_DEPENDENCY");
      visit(dependency);
    }
    visiting.delete(key);
    done.add(key);
  }
  for (const t of v.tasks) visit(t.key);
  const stages = [...new Set(v.tasks.map((t) => t.stage))].sort(
    (a, b) => a - b,
  );
  if (
    v.stage_weeks !== undefined &&
    (!Array.isArray(v.stage_weeks) ||
      v.stage_weeks.length !== stages.length ||
      v.stage_weeks.some(
        (s, i) =>
          !s ||
          Object.keys(s).some((k) => !["stage", "weeks"].includes(k)) ||
          s.stage !== stages[i] ||
          !Number.isInteger(s.weeks) ||
          s.weeks < 1 ||
          s.weeks > 12,
      ) ||
      v.stage_weeks.reduce((n, s) => n + s.weeks, 0) > 12)
  )
    fail("PLAN_SCHEMA_FIELDS");
  const rendered = JSON.stringify(v).replace(
    /(?:不能|无法|并不|并非|不代表|不可|不)(?:保证成功|保证治愈)/g,
    "未作效果承诺",
  );
  if (
    /https?:|已(?:安排|入历|购买|完成研究)|保证(?:成功|治愈)|自行(?:停药|加药)|\d+\s*(?:毫克|mg)/i.test(
      rendered,
    )
  )
    fail("PLAN_UNSAFE_CONTENT");
  const ids = new Map(v.tasks.map((t) => [t.key, crypto.randomUUID()]));
  return {
    schema_version: 1 as const,
    status: "draft" as const,
    verification_status: "unverified" as const,
    ...v,
    tasks: v.tasks.map((t) => ({
      ...t,
      id: ids.get(t.key)!,
      depends_on: t.depends_on.map((k) => ids.get(k)!),
    })),
    weekly_minutes: v.tasks.reduce(
      (sum, t) => sum + t.duration_minutes * t.frequency_per_week,
      0,
    ),
    time_fit: "needs_user_review" as const,
    cost_status: "unknown" as const,
    scheduling_status: "not_checked" as const,
  };
}
