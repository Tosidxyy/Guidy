import type { D1Database } from "@cloudflare/workers-types";
import { parseWindows } from "./chat.ts";
import { calendarSnapshot, type BusyEvent } from "./calendar.ts";
import {
  ASK_AUTO,
  ASK_SCHEDULE,
  CONFIRM_SCHEDULE,
  ASK_WEEK,
  CONFIRM_WEEK,
} from "./chat.ts";
import { isDraftEditText } from "../agent/input-intent.ts";
export const ASK_BUSY = "请帮我记录已有占用。";
export const CONFIRM_BUSY = "确认保存这些已有占用。";
export function isBusyText(text: string) {
  return (
    text === ASK_BUSY || text === CONFIRM_BUSY || /^已有占用[：:]/.test(text)
  );
}
export type BusyProposal = {
  calendar_revision: number;
  timezone: "Asia/Shanghai" | "UTC";
  events: BusyEvent[];
  confirmed_from_run_id?: string;
};
export async function busyChat(
  db: D1Database,
  owner: string,
  goalId: string,
  text: string,
  key: string,
  payload: string,
  chatRevision: number,
  goalRevision: number,
) {
  const last = await db
    .prepare(
      "SELECT id,turn_index,goal_revision,reply_json FROM agent_runs WHERE goal_id=? AND owner_id=? ORDER BY turn_index DESC LIMIT 1",
    )
    .bind(goalId, owner)
    .first();
  if (!isBusyText(text)) {
    const r = last?.reply_json ? JSON.parse(String(last.reply_json)) : null;
    if (
      [
        ASK_AUTO,
        ASK_SCHEDULE,
        CONFIRM_SCHEDULE,
        ASK_WEEK,
        CONFIRM_WEEK,
      ].includes(text) ||
      /^可用时段[：:]/.test(text) ||
      isDraftEditText(text) ||
      text === "先到这里，请根据现有信息准备方案草稿。" ||
      text === "请继续澄清仍未明确的条件。" ||
      r?.source !== "harness" ||
      !["busy_guidance", "busy_proposed"].includes(r.stage)
    )
      return null;
  }
  const snapshot = await calendarSnapshot(db, owner),
    now = Date.now(),
    id = crypto.randomUUID();
  let busy: BusyProposal | undefined,
    stage = "busy_guidance",
    saved = false;
  const date = new Date(now + 2 * 86400000).toISOString().slice(0, 10);
  let question = `哪些具体日期和时段已有安排？例如：已有占用：北京时间，${date} 09:00-18:00。首批支持未来31天内最多7个明确同日时段，重复工作日规则请先换成具体日期；核对后保存到账号日历，不移动已有事件。`;
  if (text === CONFIRM_BUSY) {
    const reply = last?.reply_json ? JSON.parse(String(last.reply_json)) : null;
    const p: BusyProposal | undefined =
      reply?.stage === "busy_proposed" ? reply.busy : undefined;
    if (
      !last ||
      !p ||
      last.goal_revision !== goalRevision ||
      last.turn_index !== chatRevision ||
      p.calendar_revision !== snapshot.revision ||
      p.events.some((e) => e.start_at <= now)
    )
      question = "占用提议已过期或日历已改变，请重新提供并核对时段；没有保存。";
    else {
      busy = {
        ...p,
        calendar_revision: snapshot.revision + 1,
        confirmed_from_run_id: String(last.id),
      };
      stage = "busy_saved";
      saved = true;
      question =
        "这些已有占用已保存到账号日历。旧排程预览需重新核对；没有创建目标任务或提醒。";
    }
  } else if (text !== ASK_BUSY) {
    const parsed = parseWindows(
      text.replace(/^已有占用[：:]/, "可用时段："),
      now,
    );
    if (!parsed)
      question =
        "已有占用尚不能确定。请注明北京时间或UTC、完整日期及起止时间；只支持未来31天内最多7个不重叠同日时段，不猜测重复规则。";
    else {
      const fresh = parsed.windows.filter(
        (w) =>
          !snapshot.events.some(
            (e) => e.start_at === w.start_at && e.end_at === w.end_at,
          ),
      );
      if (!fresh.length) question = "这些占用已经保存，不会重复添加。";
      else if (snapshot.events.length + fresh.length > 500)
        question = "账号已有占用已达500项上限，暂不能添加；现有记录保留。";
      else {
        busy = {
          calendar_revision: snapshot.revision,
          timezone: parsed.timezone,
          events: fresh.map((w) => ({
            ...w,
            id: crypto.randomUUID(),
            timezone: parsed.timezone,
            title: "已确认占用",
            fixed: 1,
            source: "user",
          })),
        };
        stage = "busy_proposed";
        question =
          "请核对这些已有占用。确认后保存到账号日历、供所有目标避让；已有重复时段已忽略，不创建提醒或目标任务。";
      }
    }
  }
  const reply = {
    schema_version: 1,
    kind: "notice",
    source: "harness",
    requested_slot: null,
    stage,
    question,
    reason:
      "仅用户明确确认才保存已有占用；AI不移动固定事件或自动批准目标计划。",
    ...(busy ? { busy } : {}),
  };
  const statements = [
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) SELECT ?,id,owner_id,?,?,?,revision,?,'succeeded','busy-chat-v1',?,?,?,? FROM goals WHERE id=? AND owner_id=? AND revision=? AND status='draft' AND active_plan_version_id IS NULL AND (SELECT coalesce(max(turn_index),0) FROM agent_runs WHERE goal_id=goals.id)=? AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=goals.id AND status='running') AND (SELECT count(*) FROM agent_runs WHERE goal_id=goals.id AND harness_version='busy-chat-v1')<40 AND coalesce((SELECT revision FROM calendar_states WHERE owner_id=goals.owner_id),0)=? AND (SELECT count(*) FROM calendar_events WHERE owner_id=goals.owner_id)+?<=500",
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
        snapshot.revision,
        saved ? busy!.events.length : 0,
      ),
  ];
  if (saved && busy) {
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO calendar_states(owner_id,revision) SELECT owner_id,0 FROM agent_runs WHERE id=? AND owner_id=?",
        )
        .bind(id, owner),
    );
    statements.push(
      db
        .prepare(
          "UPDATE calendar_states SET revision=revision+1,last_run_id=? WHERE owner_id=? AND revision=? AND EXISTS(SELECT 1 FROM agent_runs WHERE id=? AND owner_id=?)",
        )
        .bind(id, owner, snapshot.revision, id, owner),
    );
    for (const event of busy.events)
      statements.push(
        db
          .prepare(
            "INSERT INTO calendar_events(id,owner_id,title,start_at,end_at,timezone,source_run_id,source_goal_id,created_at) SELECT ?,owner_id,?,?,?,?,?,?,? FROM calendar_states WHERE owner_id=? AND revision=? AND last_run_id=?",
          )
          .bind(
            event.id,
            event.title,
            event.start_at,
            event.end_at,
            event.timezone,
            id,
            goalId,
            now,
            owner,
            snapshot.revision + 1,
            id,
          ),
      );
  }
  statements.push(
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'user',user_text,created_at FROM agent_runs WHERE id=? AND owner_id=?",
      )
      .bind(crypto.randomUUID(), id, owner),
  );
  statements.push(
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'assistant',reply_json,created_at FROM agent_runs WHERE id=? AND owner_id=?",
      )
      .bind(crypto.randomUUID(), id, owner),
  );
  const result = await db.batch(statements);
  if (result[0].meta.changes) return { status: 200 };
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
