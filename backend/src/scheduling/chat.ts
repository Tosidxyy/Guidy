import type { D1Database } from "@cloudflare/workers-types";
import { isDraftEditText } from "../agent/draft-edit.ts";
import {
  previewSchedule,
  type Interval,
  type PreviewTask,
  type PreviewResult,
} from "./preview.ts";

export const ASK_SCHEDULE = "请帮我预览首阶段各项一次的具体时间。";
export const CONFIRM_SCHEDULE = "确认这些时段，预览首阶段各项一次。";
export function isScheduleText(text: string) {
  return (
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
type TrialTask = PreviewTask & { title: string };
export type ScheduleData = {
  attempt_id: string;
  goal_revision: number;
  review_revision: number;
  timezone: "Asia/Shanghai" | "UTC";
  windows: Interval[];
  scope: "first_stage_once_v1";
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
        "SELECT j.id,p.draft_json,p.goal_revision FROM planning_jobs j LEFT JOIN plan_draft_attempts p ON p.id=j.id AND p.owner_id=j.owner_id AND p.status='succeeded' WHERE j.goal_id=? AND j.owner_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT 1",
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
  const exampleDate2 = new Date(now + 4 * 86400000).toISOString().slice(0, 10);
  let stage = "schedule_guidance",
    schedule: ScheduleData | undefined;
  let question = `哪几个具体日期和时段有空？首批支持北京时间或UTC，例如：可用时段：北京时间，${exampleDate} 20:00-21:00；${exampleDate2} 20:00-21:00。请填写未来31天内的日期，最多7个时段；这次只试排首阶段各项一次。`;
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
    if (text === CONFIRM_SCHEDULE) {
      const previous = last?.reply_json
        ? JSON.parse(String(last.reply_json))
        : null;
      const candidate: ScheduleData | undefined =
        previous?.stage === "schedule_proposed" ? previous.schedule : undefined;
      if (
        !candidate ||
        last.turn_index !== chatRevision ||
        candidate.attempt_id !== source.id ||
        candidate.goal_revision !== goalRevision ||
        candidate.review_revision !== revision ||
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
            horizon: {
              start_at: candidate.windows[0].start_at,
              end_at: candidate.windows.at(-1)!.end_at,
            },
            windows: candidate.windows,
            busy: [],
            tasks: candidate.tasks,
            completed_dependencies: [],
          }),
        };
        stage = "schedule_preview";
        question =
          "已根据你确认的时段试排首阶段各项一次。尚未检查真实日历占用或完整领域约束，没有写入日历。";
      }
    } else if (text !== ASK_SCHEDULE) {
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
          stage = "schedule_proposed";
          question =
            "请核对以下可用时段。确认后仅试排首阶段各项一次，暂不展开每周频次，也不批准入历。";
        }
      } else
        question = `时段尚不能确定。请注明北京时间或UTC，以及完整日期和起止时间，例如：可用时段：北京时间，${exampleDate} 20:00-21:00。只支持未来31天内最多7个不重叠的同日时段，不猜测“明天”“你来安排”或其他时区。`;
    }
  }
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
    reason:
      "仅核对用户声明的可用窗，不读取外部日历；试排不代表完整周期或生效计划。",
    ...(policy
      ? {}
      : { requested_slot: null, stage, ...(schedule ? { schedule } : {}) }),
  };
  const id = crypto.randomUUID();
  const claim = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) SELECT ?,id,owner_id,?,?,?,revision,?,'succeeded','schedule-chat-v1',?,?,?,? FROM goals WHERE id=? AND owner_id=? AND revision=? AND status='draft' AND active_plan_version_id IS NULL AND (SELECT coalesce(max(turn_index),0) FROM agent_runs WHERE goal_id=goals.id)=? AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=goals.id AND status='running') AND (SELECT count(*) FROM agent_runs WHERE goal_id=goals.id AND harness_version='schedule-chat-v1')<40 AND (? IS NULL OR ((SELECT id FROM planning_jobs WHERE goal_id=goals.id AND owner_id=goals.owner_id ORDER BY created_at DESC,id DESC LIMIT 1)=? AND (SELECT coalesce(max(revision),0) FROM plan_draft_reviews WHERE attempt_id=? AND owner_id=goals.owner_id)=?))",
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
