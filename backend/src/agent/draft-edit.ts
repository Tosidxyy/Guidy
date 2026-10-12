import type { D1Database } from "@cloudflare/workers-types";
type Task = {
  id: string;
  title: string;
  duration_minutes: number;
  frequency_per_week: number;
};
export function isDraftEditText(text: string) {
  return /(?:改|调整|缩短|增加|减少).*(?:分钟|每次|每周|频次|时长)|第\s*[一二三四五六1-6].*(?:项|任务|步骤)/u.test(
    text.replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    ),
  );
}
function number(s: string): number | null {
  if (/^\d{1,3}$/.test(s)) return Number(s);
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const tens = (v: string): number | null => {
    if (v === "") return 0;
    if (Object.hasOwn(digits, v)) return digits[v];
    const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(v);
    return m
      ? (m[1] ? digits[m[1]] : 1) * 10 + (m[2] ? digits[m[2]] : 0)
      : null;
  };
  if (s.startsWith("一百")) {
    const tail = tens(s.slice(2).replace(/^零/, ""));
    return tail === null ? null : 100 + tail;
  }
  return tens(s);
}
export function parseDraftEdit(raw: string, tasks: Task[]) {
  const text = raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();
  const ord = [
    ...text.matchAll(/第\s*([一二三四五六1-6])\s*(?:项|个任务|步|个步骤)/g),
  ];
  let task: Task | undefined,
    target = "";
  if (ord.length === 1) {
    const i = number(ord[0][1]);
    task = i === null ? undefined : tasks[i - 1];
    target = ord[0][0];
  } else if (ord.length === 0) {
    const hits = tasks.filter((t) => text.includes(t.title));
    if (hits.length === 1) {
      task = hits[0];
      target = task.title;
    }
  }
  if (!task || ord.length > 1) return null;
  const minutes = [
    ...text.matchAll(
      /每次(?:改为|改成|调整为|用时)?\s*([0-9一二两三四五六七八九十百零]+)\s*分钟/g,
    ),
  ];
  const freq = [
    ...text.matchAll(
      /每周(?:改为|改成|调整为)?\s*([0-9一二两三四五六七八九十百零]+)\s*次/g,
    ),
  ];
  if (
    minutes.length > 1 ||
    freq.length > 1 ||
    (!minutes.length && !freq.length)
  )
    return null;
  const rest = [...minutes, ...freq]
    .reduce((s, m) => s.replace(m[0], ""), text.replace(target, ""))
    .replace(
      /请|帮我|把|将|任务|改为|改成|调整为|调整到|调整|设置为|改|为|和|与|[\s，,。；;、：“”"'！!]/g,
      "",
    );
  if (rest) return null;
  const duration = minutes.length
      ? number(minutes[0][1])
      : task.duration_minutes,
    frequency = freq.length ? number(freq[0][1]) : task.frequency_per_week;
  if (
    duration === null ||
    frequency === null ||
    duration < 5 ||
    duration > 120 ||
    frequency < 1 ||
    frequency > 7
  )
    return null;
  return {
    task,
    before: {
      duration_minutes: task.duration_minutes,
      frequency_per_week: task.frequency_per_week,
    },
    after: { duration_minutes: duration, frequency_per_week: frequency },
  };
}
export async function proposeChatEdit(
  db: D1Database,
  owner: string,
  goalId: string,
  text: string,
  key: string,
  payload: string,
  chatRevision: number,
  goalRevision: number,
) {
  if (!isDraftEditText(text)) return null;
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
      .prepare("SELECT description FROM goals WHERE id=? AND owner_id=?")
      .bind(goalId, owner),
  ]);
  const source = rows[0].results[0],
    now = Date.now(),
    id = crypto.randomUUID();
  let proposal;
  let message =
    "请一次说明一项任务的具体时长或次数，例如：把第一项改成每次15分钟，每周4次。";
  const policy =
    !!rows[1].results.length ||
    /处方|停药|减药|增药|药物剂量|诊断|自杀|自残|伤病|怀孕|糖尿病|心脏病/.test(
      text + String(rows[2].results[0]?.description ?? ""),
    );
  if (!source?.draft_json)
    message = "当前还没有可修改的最新方案草稿，请先完成生成。";
  else if (source.goal_revision !== goalRevision)
    message = "目标条件已改变，这份草稿暂不可调整，请先核对最新方案。";
  else {
    const latest = await db
      .prepare(
        "SELECT revision,draft_json FROM plan_draft_reviews WHERE attempt_id=? AND owner_id=? ORDER BY revision DESC LIMIT 1",
      )
      .bind(source.id, owner)
      .first();
    const draft = JSON.parse(String(latest?.draft_json ?? source.draft_json)),
      edit = parseDraftEdit(text, draft.tasks);
    if (Number(latest?.revision ?? 0) >= 20)
      message = "这份草稿已达到20个审阅版本上限，已有版本保留。";
    else if (edit) {
      if (
        edit.before.duration_minutes === edit.after.duration_minutes &&
        edit.before.frequency_per_week === edit.after.frequency_per_week
      )
        message = "这项时长和频次已经是你提出的数值，无需保存新版本。";
      else {
        proposal = {
          attempt_id: String(source.id),
          goal_revision: goalRevision,
          review_revision: Number(latest?.revision ?? 0),
          task_id: edit.task.id,
          task_title: edit.task.title,
          before: edit.before,
          after: edit.after,
          weekly_before: draft.weekly_minutes,
          weekly_after:
            draft.weekly_minutes -
            edit.before.duration_minutes * edit.before.frequency_per_week +
            edit.after.duration_minutes * edit.after.frequency_per_week,
        };
        message =
          "这次调整只改变时长与频次，请核对差异后采用；原稿、任务步骤、依赖和引用保留。";
      }
    }
  }
  if (policy) {
    proposal = undefined;
    message =
      "这涉及需要专业人员判断的问题，请先核对适用性；当前不会调整任务或安排日历。";
  }
  const reply = {
    schema_version: 1,
    kind: policy ? "referral" : "notice",
    source: policy ? "policy" : "harness",
    question: message,
    reason: "只提出待确认差异，不自动保存或执行。",
    ...(policy
      ? {}
      : {
          requested_slot: null,
          stage: proposal ? "edit_proposed" : "edit_guidance",
          ...(proposal ? { edit_proposal: proposal } : {}),
        }),
  };
  const claim = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) SELECT ?,id,owner_id,?,?,?,revision,?,'succeeded','draft-edit-v1',?,?,?,? FROM goals WHERE id=? AND owner_id=? AND revision=? AND status='draft' AND active_plan_version_id IS NULL AND (SELECT coalesce(max(turn_index),0) FROM agent_runs WHERE goal_id=goals.id)=? AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=goals.id AND status='running') AND (SELECT count(*) FROM agent_runs WHERE goal_id=goals.id AND harness_version='draft-edit-v1')<40",
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
