import { planCycle } from "./cycle.ts";
import {
  automaticScheduleKey,
  automaticScheduleRequest,
} from "./automatic-key.ts";
import { planningCalendarSnapshot } from "./calendar.ts";
import type { D1Database } from "@cloudflare/workers-types";
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
  ]);
  const chatRevision = Number(rows[0].results[0].revision),
    key = await automaticScheduleRequest(db, job.owner_id, job.goal_id);
  if (!key) return;
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
  scope: "full_plan_cycle_v1" | "remaining_plan_v1";
  replaces_plan_id?: string;
  parent_instance_ids?: string[];
  completed_source_ids?: string[];
  preferences?: import("../agent/schedule-preferences.ts").Preferences;
  stages?: { stage: number; weeks: number; start_at: number; end_at: number }[];
  period_basis?: "agent_draft_v1" | "assumed_one_week_per_stage_v1";
  period?: Interval;
  window_basis?: "assumed_default_v1" | "agent_proposal_v1";
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
  if (text !== ASK_AUTO) return null;
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
      .prepare("SELECT description,status FROM goals WHERE id=? AND owner_id=?")
      .bind(goalId, owner),
  ]);
  const source = rows[0].results[0],
    now = Date.now();
  const context = JSON.parse(String(source?.context_json ?? "{}"));
  const parentId =
    typeof context.replan_parent_id === "string"
      ? context.replan_parent_id
      : "";
  const pointer = await db
    .prepare(
      "SELECT plan_version_id FROM goal_active_plans WHERE goal_id=? AND owner_id=?",
    )
    .bind(goalId, owner)
    .first();
  if (
    rows[3].results[0]?.status === "active" &&
    (!parentId || pointer?.plan_version_id !== parentId)
  )
    return { status: 409, code: "CONTEXT_CHANGED" };
  const parentInstances = parentId
    ? (
        await db
          .prepare(
            "SELECT id FROM scheduled_occurrences WHERE plan_version_id=? AND owner_id=? AND status='scheduled' AND start_at>? ORDER BY id",
          )
          .bind(parentId, owner, now)
          .all()
      ).results.map((r) => String(r.id))
    : [];
  const calendar = await planningCalendarSnapshot(
    db,
    owner,
    undefined,
    parentId,
  );
  let stage = "schedule_guidance",
    schedule: ScheduleData | undefined;
  let question = "最新方案草稿尚未准备好，请稍后读取制订结果。";
  const policy =
    !!rows[1].results.length ||
    /处方|停药|减药|增药|药物剂量|诊断|自杀|自残|伤病|怀孕|糖尿病|心脏病/.test(
      text + String(rows[3].results[0]?.description ?? ""),
    );
  if (source?.draft_json && source.goal_revision === goalRevision) {
    const review = await db
      .prepare(
        "SELECT revision,draft_json FROM plan_draft_reviews WHERE attempt_id=? AND owner_id=? ORDER BY revision DESC LIMIT 1",
      )
      .bind(source.id, owner)
      .first();
    const draft = JSON.parse(String(review?.draft_json ?? source.draft_json));
    const revision = Number(review?.revision ?? 0);

    const preference = draft.time_preferences;
    const zone = preference?.timezone ?? "Asia/Shanghai",
      offset = zone === "UTC" ? 0 : 8 * 3600000,
      day = Math.floor((now + offset) / 86400000) * 86400000 - offset;
    const windows = Array.from(
      {
        length:
          (draft.stage_weeks?.reduce(
            (n: number, s: { weeks: number }) => n + s.weeks,
            0,
          ) ??
            new Set(draft.tasks.map((t: { stage: number }) => t.stage)).size) *
          7,
      },
      (_, i) => ({
        start_at:
          day + (i + 1) * 86400000 + (preference?.start_minute ?? 1200) * 60000,
        end_at:
          day + (i + 1) * 86400000 + (preference?.end_minute ?? 1260) * 60000,
      }),
    );
    const expanded = planCycle(draft.tasks, draft.stage_weeks, day + 86400000);
    if (
      key !==
        automaticScheduleKey(
          String(source.id),
          revision,
          calendar.revision,
          zone,
          now,
        ) &&
      key !== `auto_schedule_${source.id}_${revision}_${calendar.revision}`
    )
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
      const unavailableDays = new Set<number>(
        preference?.excluded_weekdays ?? [],
      );
      for (const note of preference ? [] : notes) {
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
        ...(parentId
          ? { replaces_plan_id: parentId, parent_instance_ids: parentInstances }
          : {}),
        ...expanded,
        window_basis: preference ? "agent_proposal_v1" : "assumed_default_v1",
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
        "我已根据当前草稿的时间建议展开完整周期。你可以继续补充偏好；确认前不会加入日历。";
    } else question = "现有依赖还不能安全展开日程，方案草稿已保留。";
  }
  if (policy) {
    schedule = undefined;
    question =
      "这涉及需要专业人员判断的问题，请先核对适用性；当前不会安排日历。";
  }
  const reply = {
    schema_version: 1,
    kind: policy ? "referral" : "notice",
    source: policy ? "policy" : "harness",
    question,
    reason: "根据现有信息拟定完整日程，确认方案前不会写入目标任务。",
    ...(policy
      ? {}
      : { requested_slot: null, stage, ...(schedule ? { schedule } : {}) }),
  };
  const id = crypto.randomUUID();
  const claim = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) SELECT ?,id,owner_id,?,?,?,revision,?,'succeeded','schedule-chat-v1',?,?,?,? FROM goals WHERE id=? AND owner_id=? AND revision=? AND ((status='draft' AND ?='') OR (status='active' AND (SELECT plan_version_id FROM goal_active_plans WHERE goal_id=goals.id AND owner_id=goals.owner_id)=?)) AND active_plan_version_id IS NULL AND (SELECT coalesce(max(turn_index),0) FROM agent_runs WHERE goal_id=goals.id)=? AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=goals.id AND status='running') AND (SELECT count(*) FROM agent_runs WHERE goal_id=goals.id AND harness_version='schedule-chat-v1' AND created_at>=?)<40 AND (? IS NULL OR ((SELECT id FROM planning_jobs WHERE goal_id=goals.id AND owner_id=goals.owner_id ORDER BY created_at DESC,id DESC LIMIT 1)=? AND (SELECT coalesce(max(revision),0) FROM plan_draft_reviews WHERE attempt_id=? AND owner_id=goals.owner_id)=?)) AND (? IS NULL OR coalesce((SELECT revision FROM calendar_states WHERE owner_id=goals.owner_id),0)=?)",
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
        parentId,
        parentId,
        chatRevision,
        Math.floor(now / 86400000) * 86400000,
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
