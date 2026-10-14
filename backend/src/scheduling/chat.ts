import { planCycle } from "./cycle.ts";
import { weeklyTrial } from "./weekly.ts";
import { calendarSnapshot, planningCalendarSnapshot } from "./calendar.ts";
import type { D1Database } from "@cloudflare/workers-types";
import { isDraftEditText } from "../agent/input-intent.ts";
import {
  previewSchedule,
  type Interval,
  type PreviewTask,
  type PreviewResult,
} from "./preview.ts";

export const ASK_AUTO = "请根据现有信息直接拟定一周安排。";
export async function ensureAutomaticSchedule(
  db: D1Database,
  job: { id: string; goal_id: string; owner_id: string; goal_revision: number },
) {
  const rows = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        "SELECT coalesce(max(turn_index),0) revision FROM agent_runs WHERE goal_id=? AND owner_id=?",
      )
      .bind(job.goal_id, job.owner_id),
    db
      .prepare(
        "SELECT coalesce(max(revision),0) revision FROM plan_draft_reviews WHERE attempt_id=? AND owner_id=?",
      )
      .bind(job.id, job.owner_id),
    db
      .prepare("SELECT revision FROM calendar_states WHERE owner_id=?")
      .bind(job.owner_id),
  ]);
  const chatRevision = Number(rows[0].results[0].revision),
    revision = Number(rows[1].results[0].revision),
    cal = Number(rows[2].results[0]?.revision ?? 0),
    key = `auto_schedule_${job.id}_${revision}_${cal}`;
  if (
    await db
      .prepare("SELECT id FROM agent_runs WHERE owner_id=? AND request_key=?")
      .bind(job.owner_id, key)
      .first()
  )
    return;
  await scheduleChat(
    db,
    job.owner_id,
    job.goal_id,
    ASK_AUTO,
    key,
    JSON.stringify({
      text: ASK_AUTO,
      chatRevision,
      goalRevision: job.goal_revision,
    }),
    chatRevision,
    job.goal_revision,
  );
}
export const ASK_WEEK = "请帮我按每周频次预览首阶段一周。";
export const CONFIRM_WEEK =
  "确认这些时段，按频次试排首阶段一周，同项每天最多一次。";
export const ASK_SCHEDULE = "请帮我预览首阶段各项一次的具体时间。";
export const CONFIRM_SCHEDULE = "确认这些时段，预览首阶段各项一次。";
export function isScheduleText(text: string) {
  return (
    text === ASK_AUTO ||
    text === ASK_WEEK ||
    text === CONFIRM_WEEK ||
    text === ASK_SCHEDULE ||
    text === CONFIRM_SCHEDULE ||
    /^可用时段[：:]/.test(text) ||
    /(?:北京时间|Asia\/Shanghai|UTC).*(?:\d{4}-\d{2}-\d{2}|明天|周[一二三四五六日天])/.test(
      text,
    )
  );
}
export function parseWindows(
  text: string,
  now = Date.now(),
): { timezone: "Asia/Shanghai" | "UTC"; windows: Interval[] } | null {
  const raw = text.replace(/^可用时段[：:]\s*/, "").trim();
  const match = /^(北京时间|Asia\/Shanghai|UTC)[，,：:\s]+(.+)$/.exec(raw);
  if (!match) return null;
  const timezone = match[1] === "UTC" ? "UTC" : "Asia/Shanghai";
  const chunks = match[2]
    .split(/[；;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!chunks.length || chunks.length > 7) return null;
  const windows: Interval[] = [];
  for (const chunk of chunks) {
    const value =
      /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*[-–至]\s*(\d{2}:\d{2})$/.exec(
        chunk,
      );
    if (!value) return null;
    const [date, start, end] = value.slice(1);
    const offset = timezone === "UTC" ? "Z" : "+08:00";
    const start_at = Date.parse(`${date}T${start}:00${offset}`),
      end_at = Date.parse(`${date}T${end}:00${offset}`);
    // Date.parse normalizes impossible dates and 24:00; require exact round-trip.
    const local = (at: number) =>
      new Date(at + (timezone === "UTC" ? 0 : 8 * 3600000))
        .toISOString()
        .slice(0, 16);
    if (
      !Number.isSafeInteger(start_at) ||
      !Number.isSafeInteger(end_at) ||
      local(start_at) !== `${date}T${start}` ||
      local(end_at) !== `${date}T${end}` ||
      start_at <= now ||
      end_at <= start_at ||
      end_at > now + 31 * 86400000
    )
      return null;
    windows.push({ start_at, end_at });
  }
  windows.sort((a, b) => a.start_at - b.start_at || a.end_at - b.end_at);
  if (
    windows.some(
      (entry, index) => index > 0 && entry.start_at < windows[index - 1].end_at,
    )
  )
    return null;
  return { timezone, windows };
}
type TrialTask = PreviewTask & {
  title: string;
  ordinal?: number;
  repeat_count?: number;
};
export type ScheduleData = {
  attempt_id: string;
  goal_revision: number;
  review_revision: number;
  timezone: "Asia/Shanghai" | "UTC";
  windows: Interval[];
  scope:
    | "first_stage_once_v1"
    | "first_stage_week_v1"
    | "full_plan_cycle_v1"
    | "remaining_plan_v1";
  replaces_plan_id?: string;
  parent_instance_ids?: string[];
  completed_source_ids?: string[];
  preferences?: import("../agent/schedule-preferences.ts").Preferences;
  stages?: { stage: number; weeks: number; start_at: number; end_at: number }[];
  period_basis?: "agent_draft_v1" | "assumed_one_week_per_stage_v1";
  period?: Interval;
  window_basis?: "assumed_default_v1";
  unavailable_from_notes?: Interval[];
  calendar_snapshot?: { revision: number; busy: (Interval & { id: string })[] };
  tasks: TrialTask[];
  confirmed_from_run_id?: string;
  preview?: PreviewResult;
};
export async function scheduleChat(
  db: D1Database,
  owner: string,
  goalId: string,
  text: string,
  key: string,
  payload: string,
  chatRevision: number,
  goalRevision: number,
) {
  if (!isScheduleText(text)) {
    if (
      isDraftEditText(text) ||
      text === "先到这里，请根据现有信息准备方案草稿。" ||
      text === "请继续澄清仍未明确的条件。"
    )
      return null;
    const latest = await db
      .prepare(
        "SELECT reply_json FROM agent_runs WHERE goal_id=? AND owner_id=? ORDER BY turn_index DESC LIMIT 1",
      )
      .bind(goalId, owner)
      .first();
    const reply = latest?.reply_json
      ? JSON.parse(String(latest.reply_json))
      : null;
    if (
      reply?.source !== "harness" ||
      !["schedule_guidance", "schedule_proposed"].includes(reply.stage)
    )
      return null;
  }
  const rows = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        "SELECT j.id,p.draft_json,p.goal_revision,p.context_json FROM planning_jobs j LEFT JOIN plan_draft_attempts p ON p.id=j.id AND p.owner_id=j.owner_id AND p.status='succeeded' WHERE j.goal_id=? AND j.owner_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT 1",
      )
      .bind(goalId, owner),
    db
      .prepare(
        "SELECT 1 found FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.source')='policy' LIMIT 1",
      )
      .bind(goalId, owner),
    db
      .prepare(
        "SELECT reply_json,id,turn_index FROM agent_runs WHERE goal_id=? AND owner_id=? ORDER BY turn_index DESC LIMIT 1",
      )
      .bind(goalId, owner),
    db
      .prepare("SELECT description FROM goals WHERE id=? AND owner_id=?")
      .bind(goalId, owner),
  ]);
  const source = rows[0].results[0],
    last = rows[2].results[0],
    now = Date.now();
  const exampleDate = new Date(now + 2 * 86400000).toISOString().slice(0, 10);

  const lastReply = last?.reply_json
    ? JSON.parse(String(last.reply_json))
    : null;
  const calendar =
    text === ASK_AUTO
      ? await planningCalendarSnapshot(db, owner)
      : await calendarSnapshot(db, owner);
  const weekly =
    text === ASK_AUTO ||
    text === ASK_WEEK ||
    text === CONFIRM_WEEK ||
    (text !== ASK_SCHEDULE &&
      (lastReply?.schedule_mode === "first_stage_week_v1" ||
        lastReply?.schedule?.scope === "first_stage_week_v1"));
  let stage = "schedule_guidance",
    schedule: ScheduleData | undefined;
  let question = "你具体哪几天、什么时段有空？请同时说明时区。";
  const policy =
    !!rows[1].results.length ||
    /处方|停药|减药|增药|药物剂量|诊断|自杀|自残|伤病|怀孕|糖尿病|心脏病/.test(
      text + String(rows[3].results[0]?.description ?? ""),
    );
  if (!source?.draft_json)
    question = "请先生成最新方案草稿，再提供具体可用时段。";
  else if (source.goal_revision !== goalRevision)
    question = "目标条件已改变，请先核对最新方案，再预览时间。";
  else {
    const review = await db
      .prepare(
        "SELECT revision,draft_json FROM plan_draft_reviews WHERE attempt_id=? AND owner_id=? ORDER BY revision DESC LIMIT 1",
      )
      .bind(source.id, owner)
      .first();
    const draft = JSON.parse(String(review?.draft_json ?? source.draft_json));
    const revision = Number(review?.revision ?? 0);
    if (text === ASK_AUTO) {
      const zone = "Asia/Shanghai",
        offset = 8 * 3600000,
        day = Math.floor((now + offset) / 86400000) * 86400000 - offset;
      const windows = Array.from(
        {
          length:
            (draft.stage_weeks?.reduce(
              (n: number, s: { weeks: number }) => n + s.weeks,
              0,
            ) ??
              new Set(draft.tasks.map((t: { stage: number }) => t.stage))
                .size) * 7,
        },
        (_, i) => ({
          start_at: day + (i + 1) * 86400000 + 20 * 3600000,
          end_at: day + (i + 1) * 86400000 + 21 * 3600000,
        }),
      );
      const expanded = planCycle(
        draft.tasks,
        draft.stage_weeks,
        day + 86400000,
      );
      if (key !== `auto_schedule_${source.id}_${revision}_${calendar.revision}`)
        return { status: 409, code: "CONTEXT_CHANGED" };
      if (expanded) {
        const context = JSON.parse(String(source.context_json ?? "{}"));
        const notes = [
          ...(context.dialogue_notes ?? []),
          ...(context.conditions ?? [])
            .filter(
              (s: { source: string; value: { state: string } }) =>
                s.source === "user" && s.value.state === "confirmed",
            )
            .map((s: { value: { text: string } }) => s.value.text),
        ];
        const unavailableDays = new Set<number>();
        for (const note of notes) {
          if (
            typeof note !== "string" ||
            /不是|并非|假如|如果|可能|不确定|未必|举例|比如|没说|没有说|不觉得|不认为|但|除|不过|取消|不要|改为|改成/.test(
              note,
            )
          )
            continue;
          for (const match of note.matchAll(
            /(?:周|星期)([一二三四五六日天])(?:没空|没有时间|不方便)/g,
          )) {
            unavailableDays.add(
              "日一二三四五六".indexOf(match[1] === "天" ? "日" : match[1]),
            );
          }
        }
        const unavailable = windows.filter((w) =>
          unavailableDays.has(new Date(w.start_at + offset).getUTCDay()),
        );
        const busy = calendar.events
          .filter(
            (e) =>
              e.start_at < expanded.period.end_at &&
              e.end_at > expanded.period.start_at,
          )
          .map((e) => ({ id: e.id, start_at: e.start_at, end_at: e.end_at }));
        schedule = {
          attempt_id: String(source.id),
          goal_revision: goalRevision,
          review_revision: revision,
          timezone: zone,
          windows,
          scope: "full_plan_cycle_v1",
          ...expanded,
          window_basis: "assumed_default_v1",
          unavailable_from_notes: unavailable,
          calendar_snapshot: { revision: calendar.revision, busy },
          preview: previewSchedule({
            schema_version: 1,
            period_mode: "full_plan_cycle_v1",
            timezone: zone,
            horizon: expanded.period,
            windows,
            busy: [...busy, ...unavailable],
            tasks: expanded.tasks,
            completed_dependencies: [],
          }),
        };
        stage = "schedule_preview";
        question =
          "我先给出所有阶段的建议日程。暂按北京时间、每天20点至21点作为候选时间；你可以继续补充没空的日期或希望调整的时间。";
      } else question = "现有依赖还不能安全展开日程，方案草稿已保留。";
    } else if (text === CONFIRM_SCHEDULE || text === CONFIRM_WEEK) {
      const previous = last?.reply_json
        ? JSON.parse(String(last.reply_json))
        : null;
      const candidate: ScheduleData | undefined =
        previous?.stage === "schedule_proposed" ? previous.schedule : undefined;
      if (
        !candidate ||
        (text === CONFIRM_WEEK
          ? candidate.scope !== "first_stage_week_v1"
          : candidate.scope !== "first_stage_once_v1") ||
        last.turn_index !== chatRevision ||
        candidate.attempt_id !== source.id ||
        candidate.goal_revision !== goalRevision ||
        candidate.review_revision !== revision ||
        candidate.calendar_snapshot?.revision !== calendar.revision ||
        candidate.windows.some((entry) => entry.start_at <= now)
      ) {
        question =
          "这份时段提议已过期或方案已改变，请重新提供时段并核对后预览。";
      } else {
        schedule = {
          ...candidate,
          confirmed_from_run_id: String(last.id),
          preview: previewSchedule({
            schema_version: 1,
            timezone: candidate.timezone,
            horizon: candidate.period ?? {
              start_at: candidate.windows[0].start_at,
              end_at: candidate.windows.at(-1)!.end_at,
            },
            windows: candidate.windows,
            busy: candidate.calendar_snapshot!.busy,
            tasks: candidate.tasks,
            completed_dependencies: [],
          }),
        };
        stage = "schedule_preview";
        question =
          "已根据你确认的时段试排首阶段各项一次。尚未检查真实日历占用或完整领域约束，没有写入日历。";
      }
    } else if (text !== ASK_SCHEDULE && text !== ASK_WEEK) {
      const parsed = parseWindows(text, now);
      if (parsed) {
        const firstStage = Math.min(
          ...draft.tasks.map((task: { stage: number }) => task.stage),
        );
        const tasks: TrialTask[] = draft.tasks
          .filter((task: { stage: number }) => task.stage === firstStage)
          .map((task: TrialTask) => ({
            id: task.id,
            title: task.title,
            duration_minutes: task.duration_minutes,
            depends_on: [...task.depends_on],
          }));
        if (
          tasks.some((task) =>
            task.depends_on.some(
              (dependency) => !tasks.some((parent) => parent.id === dependency),
            ),
          )
        )
          question =
            "首阶段有本次范围之外的前置任务，尚不能核实完成，暂不试排。请先核对方案依赖。";
        else {
          schedule = {
            attempt_id: String(source.id),
            goal_revision: goalRevision,
            review_revision: revision,
            ...parsed,
            scope: "first_stage_once_v1",
            tasks,
          };
          if (weekly) {
            const selected = draft.tasks.filter(
              (task: { stage: number }) => task.stage === firstStage,
            );
            const expanded = weeklyTrial(
              selected,
              parsed.windows,
              parsed.timezone,
            );
            if (!expanded) {
              schedule = undefined;
              question =
                "一周试排的时段须全部落在首个日期起的连续7天内，请重新提供；不猜测其他阶段或范围外依赖。";
            } else {
              schedule = {
                ...schedule,
                ...expanded,
                scope: "first_stage_week_v1",
              };
            }
          }
          stage = schedule ? "schedule_proposed" : "schedule_guidance";
          if (schedule)
            question = weekly
              ? "请核对首阶段一周的时段与频次：同项每天最多一次，前置项本周试排实例全部排完后再排后续项；不足会标记未安排，不批准入历。"
              : "请核对以下可用时段。确认后仅试排首阶段各项一次，暂不展开每周频次，也不批准入历。";
        }
      } else
        question =
          "日期、时区或时间还没确定，可以说明具体日期、几点到几点，以及北京时间或UTC吗？";
    }
  }
  if (
    weekly &&
    text === ASK_WEEK &&
    source?.draft_json &&
    source.goal_revision === goalRevision
  )
    question = "接下来一周，你具体哪几天、什么时段有空？请同时说明时区。";
  if (weekly && stage === "schedule_preview")
    question =
      "已按确认的一周频次及每日一次规则试排首阶段。尚未检查真实日历占用或完整领域约束，没有写入日历。";
  if (schedule && stage === "schedule_proposed") {
    const horizon = schedule.period ?? {
      start_at: schedule.windows[0].start_at,
      end_at: schedule.windows.at(-1)!.end_at,
    };
    schedule.calendar_snapshot = {
      revision: calendar.revision,
      busy: calendar.events
        .filter(
          (e) => e.start_at < horizon.end_at && e.end_at > horizon.start_at,
        )
        .map((e) => ({ id: e.id, start_at: e.start_at, end_at: e.end_at })),
    };
  }
  if (stage === "schedule_preview" && text !== ASK_AUTO)
    question =
      "已避开账号日历中已确认的占用生成时间预览。未核实其他日程或完整领域约束，没有批准或写入目标任务。";
  if (policy) {
    schedule = undefined;
    question =
      "这涉及需要专业人员判断的问题，请先核对适用性；当前不会预览或安排日历。";
  }
  const reply = {
    schema_version: 1,
    kind: policy ? "referral" : "notice",
    source: policy ? "policy" : "harness",
    question,
    reason: "我会先核对时间，再展示安排；确认方案前不会写入目标任务。",
    ...(policy
      ? {}
      : {
          requested_slot: null,
          stage,
          ...(stage === "schedule_guidance" &&
          source?.draft_json &&
          source.goal_revision === goalRevision
            ? {
                schedule_help: {
                  example_text: `北京时间，${exampleDate} 20:00-21:00`,
                },
              }
            : {}),
          ...(weekly && text !== ASK_AUTO
            ? { schedule_mode: "first_stage_week_v1" }
            : {}),
          ...(schedule ? { schedule } : {}),
        }),
  };
  const id = crypto.randomUUID();
  const claim = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) SELECT ?,id,owner_id,?,?,?,revision,?,'succeeded','schedule-chat-v1',?,?,?,? FROM goals WHERE id=? AND owner_id=? AND revision=? AND status='draft' AND active_plan_version_id IS NULL AND (SELECT coalesce(max(turn_index),0) FROM agent_runs WHERE goal_id=goals.id)=? AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=goals.id AND status='running') AND (SELECT count(*) FROM agent_runs WHERE goal_id=goals.id AND harness_version='schedule-chat-v1')<40 AND (? IS NULL OR ((SELECT id FROM planning_jobs WHERE goal_id=goals.id AND owner_id=goals.owner_id ORDER BY created_at DESC,id DESC LIMIT 1)=? AND (SELECT coalesce(max(revision),0) FROM plan_draft_reviews WHERE attempt_id=? AND owner_id=goals.owner_id)=?)) AND (? IS NULL OR coalesce((SELECT revision FROM calendar_states WHERE owner_id=goals.owner_id),0)=?)",
      )
      .bind(
        id,
        key,
        payload,
        chatRevision + 1,
        text,
        JSON.stringify(reply),
        now,
        now,
        now,
        goalId,
        owner,
        goalRevision,
        chatRevision,
        schedule?.attempt_id ?? null,
        schedule?.attempt_id ?? null,
        schedule?.attempt_id ?? null,
        schedule?.review_revision ?? 0,
        schedule?.calendar_snapshot?.revision ?? null,
        schedule?.calendar_snapshot?.revision ?? 0,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'user',user_text,created_at FROM agent_runs WHERE id=? AND owner_id=?",
      )
      .bind(crypto.randomUUID(), id, owner),
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'assistant',reply_json,created_at FROM agent_runs WHERE id=? AND owner_id=?",
      )
      .bind(crypto.randomUUID(), id, owner),
  ]);
  if (claim[0].meta.changes) return { status: 200 };
  const old = await db
    .prepare(
      "SELECT request_payload FROM agent_runs WHERE owner_id=? AND request_key=? AND goal_id=?",
    )
    .bind(owner, key, goalId)
    .first();
  return old?.request_payload === payload
    ? { status: 200 }
    : { status: 409, code: "CONVERSATION_CHANGED" };
}
