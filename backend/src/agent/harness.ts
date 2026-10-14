import { activeReplan } from "./active-replan.ts";
import { ASK_AUTO, scheduleChat } from "../scheduling/chat.ts";
import { busyChat } from "../scheduling/busy-chat.ts";
import {
  clarificationBudget,
  clarificationLimits,
} from "./clarification-budget.ts";
import { planningStatements, dispatchPlanning } from "./planning-jobs.ts";
import type { WorkflowBinding } from "./workflow-binding.ts";
import type { D1Database } from "@cloudflare/workers-types";
import { checkedSuggestions, type SlotSuggestion } from "./suggestions.ts";
import {
  AgentError,
  deepseekProvider,
  type AgentEnv,
  type AgentProvider,
} from "./provider.ts";

import {
  delegatesTime,
  chatCapture,
  captureStatements,
  nextChatSlot,
  type CaptureKey,
  type ChatCondition,
} from "./chat-capture.ts";

type Reply = {
  schema_version: 1;
  kind: "question" | "referral" | "notice";
  question: string;
  reason: string;
  source: "deepseek" | "policy" | "harness";
  suggestions?: SlotSuggestion[];
  requested_slot?: CaptureKey | null;
  stage?:
    "clarifying" | "research_ready" | "needs_information" | "draft_requested";
  time_proposal?: "weekly_60_v1";
};
function validateReply(content: string, userText: string): Reply {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new AgentError("AI_INVALID_RESPONSE");
  }
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (k) =>
        !["question", "reason", "suggestions", "requested_slot"].includes(k),
    ) ||
    (value.requested_slot !== undefined &&
      value.requested_slot !== null &&
      !["outcome", "available_time", "constraints"].includes(
        value.requested_slot,
      )) ||
    typeof value.question !== "string" ||
    !value.question.trim() ||
    value.question.length > 240 ||
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    value.reason.length > 160 ||
    (value.question.match(/[?？]/g)?.length ?? 0) !== 1
  )
    throw new AgentError("AI_INVALID_RESPONSE");
  if (
    /已安排|已写入|已购买|已完成研究|自行(?:停药|加药)|\d+\s*(?:毫克|mg)/i.test(
      value.question + value.reason,
    )
  )
    throw new AgentError("AI_INVALID_RESPONSE");
  return {
    schema_version: 1,
    kind: "question",
    question: value.question.trim(),
    reason: value.reason.trim(),
    source: "deepseek",
    suggestions: checkedSuggestions(value.suggestions, userText),
    ...(value.requested_slot === undefined
      ? {}
      : { requested_slot: value.requested_slot }),
  };
}
export async function dialogueResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
  env: AgentEnv,
  provider?: AgentProvider,
  planningBinding?: WorkflowBinding,
): Promise<Response> {
  const goalId = new URL(request.url).pathname.split("/").at(-2)!;
  const now = Date.now();
  const limits = clarificationLimits(env);
  const ok = (data: unknown, status = 200) =>
    Response.json({ data, error: null, request_id: requestId }, { status });
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: {
          code,
          message: "AI 澄清未完成，请检查状态后重试。",
          details: null,
        },
        request_id: requestId,
      },
      { status },
    );
  const goal = await db
    .prepare(
      "SELECT id,title,description,timeframe_note,status,revision FROM goals WHERE id=? AND owner_id=?",
    )
    .bind(goalId, owner)
    .first<Record<string, unknown>>();
  if (!goal) return fail(404, "NOT_FOUND");
  // Expiration settles a stale attempt; it never restarts a paid model request.
  await db
    .prepare(
      "UPDATE agent_runs SET status='failed',error_code='AI_TIMEOUT',updated_at=? WHERE goal_id=? AND owner_id=? AND status='running' AND lease_until<=?",
    )
    .bind(now, goalId, owner, now)
    .run();
  const columns =
    "id,turn_index,user_text,status,reply_json,error_code,input_tokens,output_tokens,requested_model,context_schema_version,harness_version,goal_revision,created_at,(SELECT revision FROM plan_draft_reviews WHERE owner_id=agent_runs.owner_id AND request_key='chat_edit_'||agent_runs.id) edit_receipt_revision,CASE WHEN json_extract(reply_json,'$.stage')='edit_proposed' THEN CASE WHEN json_extract(reply_json,'$.edit_proposal.review_revision')!=(SELECT coalesce(max(revision),0) FROM plan_draft_reviews WHERE owner_id=agent_runs.owner_id AND attempt_id=json_extract(agent_runs.reply_json,'$.edit_proposal.attempt_id')) OR json_extract(reply_json,'$.edit_proposal.attempt_id')!=coalesce((SELECT id FROM planning_jobs WHERE goal_id=agent_runs.goal_id AND owner_id=agent_runs.owner_id ORDER BY created_at DESC,id DESC LIMIT 1),'') THEN 1 ELSE 0 END ELSE 0 END edit_proposal_stale,CASE WHEN json_extract(reply_json,'$.schedule.attempt_id') IS NOT NULL THEN CASE WHEN json_extract(reply_json,'$.schedule.review_revision')!=(SELECT coalesce(max(revision),0) FROM plan_draft_reviews WHERE owner_id=agent_runs.owner_id AND attempt_id=json_extract(agent_runs.reply_json,'$.schedule.attempt_id')) OR json_extract(reply_json,'$.schedule.attempt_id')!=coalesce((SELECT id FROM planning_jobs WHERE goal_id=agent_runs.goal_id AND owner_id=agent_runs.owner_id ORDER BY created_at DESC,id DESC LIMIT 1),'') THEN 1 ELSE 0 END ELSE 0 END schedule_stale";
  const askedTopics = async () =>
    (
      await db
        .prepare(
          "SELECT DISTINCT json_extract(reply_json,'$.requested_slot') topic FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.source')='deepseek' AND json_extract(reply_json,'$.requested_slot') IN ('outcome','available_time','constraints') ORDER BY topic",
        )
        .bind(goalId, owner)
        .all()
    ).results.map((r) => String(r.topic));
  const dispatchForRun = async (runId: string) => {
    const job = await db
      .prepare(
        "SELECT id FROM planning_jobs WHERE source_run_id=? AND owner_id=?",
      )
      .bind(runId, owner)
      .first();
    if (job) await dispatchPlanning(db, planningBinding, String(job.id));
  };
  const snapshot = async () => {
    const rows = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          "SELECT id,title,description,timeframe_note,status,revision FROM goals WHERE id=? AND owner_id=?",
        )
        .bind(goalId, owner),
      db
        .prepare(
          `SELECT ${columns} FROM agent_runs WHERE goal_id=? AND owner_id=? ORDER BY turn_index DESC LIMIT 30`,
        )
        .bind(goalId, owner),
      db
        .prepare("SELECT revision FROM calendar_states WHERE owner_id=?")
        .bind(owner),
    ]);
    const autoRow = await db
      .prepare(
        "SELECT id,reply_json FROM agent_runs WHERE goal_id=? AND owner_id=? AND (? IS NOT NULL) AND status='succeeded' AND json_extract(reply_json,'$.stage')='schedule_preview' AND json_extract(reply_json,'$.schedule.scope') IN ('full_plan_cycle_v1','remaining_plan_v1') ORDER BY turn_index DESC LIMIT 1",
      )
      .bind(goalId, owner, ASK_AUTO)
      .first();
    const liveGoal = rows[0].results[0];
    return {
      goal: liveGoal,
      auto_schedule: autoRow?.reply_json
        ? (JSON.parse(String(autoRow.reply_json)).schedule ?? null)
        : null,
      auto_schedule_run_id:
        autoRow?.reply_json && JSON.parse(String(autoRow.reply_json)).schedule
          ? autoRow.id
          : null,
      calendar_revision: Number(rows[2].results[0]?.revision ?? 0),
      asked_topics: await askedTopics(),
      clarification_budget: await clarificationBudget(db, owner, env),
      chat_revision: rows[1].results[0]?.turn_index ?? 0,
      runs: rows[1].results.reverse().map((r) => ({
        ...r,
        edit_proposal_stale: r.edit_proposal_stale === 1,
        busy_proposal_stale: !!(
          JSON.parse(String(r.reply_json ?? "null"))?.stage ===
            "busy_proposed" &&
          (r.goal_revision !== liveGoal.revision ||
            JSON.parse(String(r.reply_json)).busy.calendar_revision !==
              Number(rows[2].results[0]?.revision ?? 0) ||
            JSON.parse(String(r.reply_json)).busy.events.some(
              (e: { start_at: number }) => e.start_at <= now,
            ))
        ),
        schedule_stale:
          r.schedule_stale === 1 ||
          (!!JSON.parse(String(r.reply_json ?? "null"))?.schedule &&
            (JSON.parse(String(r.reply_json)).schedule.calendar_snapshot
              ?.revision !== Number(rows[2].results[0]?.revision ?? 0) ||
              r.goal_revision !== liveGoal.revision ||
              JSON.parse(String(r.reply_json)).schedule.windows[0].start_at <=
                now)),
        reply_json: undefined,
        reply: r.reply_json ? JSON.parse(r.reply_json as string) : null,
      })),
    };
  };
  if (request.method === "GET") return ok(await snapshot());
  if (request.method !== "POST") {
    const response = fail(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", "GET, POST");
    return response;
  }
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    return fail(415, "INVALID_CONTENT_TYPE");
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
    return fail(422, "INVALID_KEY");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 4096) {
        await reader.cancel();
        return fail(413, "BODY_TOO_LARGE");
      }
      chunks.push(part.value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  let text: string;
  let chatRevision: number;
  let goalRevision: number;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) =>
          ![
            "text",
            "expected_chat_revision",
            "expected_goal_revision",
          ].includes(k),
      ) ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 600 ||
      !Number.isSafeInteger(body.expected_chat_revision) ||
      body.expected_chat_revision < 0 ||
      !Number.isSafeInteger(body.expected_goal_revision) ||
      body.expected_goal_revision < 0
    )
      throw new Error();
    text = body.text.trim();
    chatRevision = body.expected_chat_revision;
    goalRevision = body.expected_goal_revision;
  } catch {
    return fail(422, "INVALID_BODY");
  }
  const answerStopPrefix = "根据当前回答开始制订：";
  const stop =
    text === "先到这里，请根据现有信息准备方案草稿。" ||
    text.startsWith(answerStopPrefix);
  const payload = JSON.stringify({ text, chatRevision, goalRevision });
  const previous = await db
    .prepare(
      "SELECT id,goal_id,request_payload,status FROM agent_runs WHERE owner_id=? AND request_key=?",
    )
    .bind(owner, key)
    .first();
  if (previous) {
    if (previous.goal_id !== goalId || previous.request_payload !== payload)
      return fail(409, "IDEMPOTENCY_CONFLICT");
    if (stop) await dispatchForRun(String(previous.id));
    return ok(await snapshot(), previous.status === "running" ? 202 : 200);
  }
  if (goal.status === "active" && goal.revision === goalRevision) {
    const result = await activeReplan(
      db,
      owner,
      goalId,
      text,
      key,
      payload,
      chatRevision,
      goalRevision,
      env,
      provider,
    );
    return result.status === 200
      ? ok(await snapshot())
      : fail(result.status, result.code!);
  }
  if (goal.status !== "draft" || goal.revision !== goalRevision)
    return fail(409, "CONTEXT_CHANGED");
  const busyResult = stop
    ? null
    : await busyChat(
        db,
        owner,
        goalId,
        text,
        key,
        payload,
        chatRevision,
        goalRevision,
      );
  if (busyResult)
    return busyResult.status === 200
      ? ok(await snapshot())
      : fail(busyResult.status, busyResult.code!);
  const schedule = stop
    ? null
    : await scheduleChat(
        db,
        owner,
        goalId,
        text,
        key,
        payload,
        chatRevision,
        goalRevision,
      );
  if (schedule)
    return schedule.status === 200
      ? ok(await snapshot())
      : fail(schedule.status, schedule.code!);
  if (stop && (await askedTopics()).length < 3)
    return fail(422, "CLARIFICATION_MINIMUM_NOT_MET");
  let model: AgentProvider | undefined;
  try {
    if (!stop) model = provider ?? deepseekProvider(env);
  } catch {
    return fail(503, "AI_NOT_CONFIGURED");
  }
  const id = crypto.randomUUID();
  const day = Math.floor(now / 86400000) * 86400000;
  const claimed = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,created_at,updated_at,lease_until) SELECT ?,id,owner_id,?,?,?,revision,?,'running',?,?,?,? FROM goals WHERE id=? AND owner_id=? AND status='draft' AND revision=? AND (SELECT coalesce(max(turn_index),0) FROM agent_runs WHERE goal_id=?)=? AND ((?=1 AND (SELECT count(*) FROM agent_runs WHERE goal_id=goals.id AND harness_version='clarify-stop-v1')<10) OR (?=0 AND (SELECT count(*) FROM agent_runs WHERE owner_id=? AND created_at>=? AND harness_version NOT IN ('clarify-stop-v1','draft-edit-v1','schedule-chat-v1','busy-chat-v1','replan-refresh-v1','replan-question-v1'))<? AND (SELECT count(*) FROM agent_runs WHERE created_at>=? AND harness_version NOT IN ('clarify-stop-v1','draft-edit-v1','schedule-chat-v1','busy-chat-v1','replan-refresh-v1','replan-question-v1'))<?))`,
      )
      .bind(
        id,
        key,
        payload,
        chatRevision + 1,
        text,
        stop ? "clarify-stop-v1" : "clarify-v3.1",
        now,
        now,
        now + 45000,
        goalId,
        owner,
        goalRevision,
        goalId,
        chatRevision,
        stop ? 1 : 0,
        stop ? 1 : 0,
        owner,
        day,
        limits.personal,
        day,
        limits.global,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'user',user_text,created_at FROM agent_runs WHERE id=? AND owner_id=?",
      )
      .bind(crypto.randomUUID(), id, owner),
  ]);
  if (!claimed[0].meta.changes) {
    const duplicate = await db
      .prepare(
        "SELECT goal_id,request_payload,status FROM agent_runs WHERE owner_id=? AND request_key=?",
      )
      .bind(owner, key)
      .first();
    if (duplicate) {
      if (duplicate.goal_id !== goalId || duplicate.request_payload !== payload)
        return fail(409, "IDEMPOTENCY_CONFLICT");
      return ok(await snapshot(), duplicate.status === "running" ? 202 : 200);
    }
    const counts = await db
      .prepare(
        "SELECT count(*) AS total,sum(CASE WHEN owner_id=? THEN 1 ELSE 0 END) AS personal FROM agent_runs WHERE created_at>=? AND harness_version NOT IN ('clarify-stop-v1','draft-edit-v1','schedule-chat-v1','busy-chat-v1','replan-refresh-v1','replan-question-v1')",
      )
      .bind(owner, day)
      .first();
    return Number(counts?.total) >= limits.global
      ? fail(429, "AI_GLOBAL_LIMIT")
      : Number(counts?.personal) >= limits.personal
        ? fail(429, "AI_DAILY_LIMIT")
        : fail(409, "CONVERSATION_CHANGED");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AgentError("AI_TIMEOUT"));
    }, 20000);
  });
  void timeout.catch(() => {});
  try {
    const contextRows = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          "SELECT title,description,timeframe_note,status,revision FROM goals WHERE id=? AND owner_id=?",
        )
        .bind(goalId, owner),
      db
        .prepare(
          "SELECT key,value_json,confirmed_at FROM goal_slots WHERE goal_id=? ORDER BY key",
        )
        .bind(goalId),
      db
        .prepare(
          "SELECT id,turn_index,user_text,reply_json,coalesce((SELECT resulting_goal_revision FROM chat_condition_captures WHERE run_id=agent_runs.id),goal_revision) effective_revision FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' ORDER BY turn_index DESC LIMIT 2",
        )
        .bind(goalId, owner),
      db
        .prepare(
          "SELECT 1 found FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.source')='policy' LIMIT 1",
        )
        .bind(goalId, owner),
    ]);
    const contextGoal = contextRows[0].results[0];
    const slots = contextRows[1];
    const history = contextRows[2];
    if (
      !contextGoal ||
      contextGoal.revision !== goalRevision ||
      contextGoal.status !== "draft"
    )
      throw new AgentError("CONTEXT_CHANGED");
    const conditions: ChatCondition[] = slots.results.map((s) => ({
      key: String(s.key),
      value: JSON.parse(s.value_json as string),
    }));
    const last = history.results.find((r) => r.turn_index === chatRevision);
    const lastReply = last ? JSON.parse(last.reply_json as string) : null;
    const preceding = lastReply
      ? {
          id: String(last!.id),
          goal_revision: Number(last!.effective_revision),
          requested_slot: lastReply.requested_slot,
          source: lastReply.source,
          time_proposal: lastReply.time_proposal,
        }
      : null;
    const context = JSON.stringify({
      goal: {
        description: contextGoal.description || contextGoal.title,
        timeframe: contextGoal.timeframe_note,
      },
      confirmed_conditions: slots.results.map((s) => ({
        key: s.key,
        value: JSON.parse(s.value_json as string),
      })),
      recent_dialogue: history.results.reverse().map((r) => ({
        user: r.user_text,
        assistant: (() => {
          const rply = JSON.parse(r.reply_json as string);
          return {
            question: rply.question,
            reason: rply.reason,
            source: rply.source,
          };
        })(),
      })),
      answer_to:
        preceding?.goal_revision === goalRevision
          ? (preceding.requested_slot ?? null)
          : null,
      next_missing_slot: nextChatSlot(conditions),
      capture_protocol: "chat-capture-v1",
      user_message: text,
    });
    if (context.length > 5000) throw new AgentError("CONTEXT_TOO_LARGE");
    await db
      .prepare(
        "UPDATE agent_runs SET context_json=? WHERE id=? AND owner_id=? AND status='running'",
      )
      .bind(context, id, owner)
      .run();
    let reply: Reply;
    let capture: ReturnType<typeof chatCapture> = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    // Safety is based on user facts, never on an assistant's hypothetical question.
    const policyInput = JSON.stringify({
      goal,
      slots: slots.results,
      users: history.results.map((r) => r.user_text),
      text,
    }).replace(/没有(?:已知)?伤病|无伤病/g, "");
    if (
      contextRows[3].results.length ||
      /处方|停药|减药|增药|药物剂量|药量|诊断|自杀|自残|伤害他人|伤病|怀孕|糖尿病|心脏病/i.test(
        policyInput,
      )
    )
      reply = {
        schema_version: 1,
        kind: "referral",
        question:
          "这涉及需要专业人员判断的问题。请先咨询相应专业人员，再确认适合你的日常目标。",
        reason: "当前不会提供诊断、处方调整或高风险行动建议。",
        source: "policy",
      };
    else if (stop)
      reply = {
        schema_version: 1,
        kind: "notice",
        source: "harness",
        question:
          "已停止这一段提问，并保存基于现有信息准备草稿的请求。生成进度与结果会显示在这段对话下方。",
        reason: "缺失信息保留为待核对假设；确认入历前仍需检查必要条件。",
        requested_slot: null,
        stage: "draft_requested",
      };
    else {
      const completion = await Promise.race([
        model!.complete(context, controller.signal),
        timeout,
      ]);
      reply = validateReply(completion.content, text);
      const extra =
        text === "请继续问我一个有助于完善方案的问题。" ||
        ((lastReply?.stage === "clarifying" ||
          (lastReply?.stage === "research_ready" &&
            text !== "请继续澄清仍未明确的条件。")) &&
          preceding?.requested_slot === null &&
          preceding.source === "deepseek");
      if (extra) {
        reply.requested_slot = null;
        reply.stage = "clarifying";
        reply.suggestions = undefined;
      } else if (
        reply.requested_slot !== undefined ||
        preceding?.time_proposal === "weekly_60_v1" ||
        (preceding?.requested_slot === "available_time" && delegatesTime(text))
      ) {
        capture = chatCapture(
          text,
          reply.suggestions ?? [],
          preceding,
          goalRevision,
          conditions,
        );
        const after = capture
          ? [
              ...conditions.filter((s) => s.key !== capture!.key),
              { key: capture.key, value: capture.value },
            ]
          : conditions;
        let target = nextChatSlot(after, text === "请继续澄清仍未明确的条件。");
        const basicReady =
          after.some(
            (s) => s.key === "outcome" && s.value.state === "confirmed",
          ) &&
          after.some(
            (s) => s.key === "available_time" && s.value.state === "confirmed",
          );
        const questionFits =
          target === null ||
          {
            outcome: /目标|希望|达成|达到|结果|成果|目的/,
            available_time: /时间|时段|分钟|小时|每周|每天|几次|次数/,
            constraints: /限制|资源|条件|要求|已有|器材|顾虑|注意/,
          }[target].test(reply.question);
        if (reply.requested_slot !== target || !questionFits) {
          const fallback = {
            outcome: "你希望这个目标最终达到什么具体结果？",
            available_time: "你每周能投入多少时间，通常哪些时段有空？",
            constraints:
              "你目前的基础、已有资源或关键限制是什么？也可以暂不确定。",
          };
          reply.question = target
            ? fallback[target]
            : "基本信息已收集，还有其他希望补充的内容吗？";
          reply.reason = "根据你的回答继续补齐必要信息，暂不安排日历。";
        }
        const delegate =
          preceding?.goal_revision === goalRevision &&
          preceding.requested_slot === "available_time" &&
          delegatesTime(text);
        if (delegate && preceding?.time_proposal !== "weekly_60_v1") {
          target = "available_time";
          reply.time_proposal = "weekly_60_v1";
          reply.question =
            "那先建议每周3次、每次20分钟，共60分钟做入门尝试，你愿意先按这个投入试试吗？";
          reply.reason =
            "这只是建议，不代表已知道你的空闲时段；同意后才记录尝试投入。";
        } else if (
          preceding?.time_proposal === "weekly_60_v1" &&
          !capture?.value.text
        ) {
          reply.question = target
            ? {
                outcome: "你希望这个目标最终达到什么具体结果？",
                available_time: "你通常有哪些可用时间？",
                constraints:
                  "我们先把时间留为待定，有什么限制或已有资源需要考虑吗？",
              }[target]
            : "时间可以先留待定，等你想好后再继续完善，可以吗？";
          reply.reason =
            "不会重复追问同一时间，也不会把委托或未知当成实际空闲。";
        }
        if (target === null) {
          reply.question = basicReady
            ? "基本信息已收集，还有其他希望补充的内容吗？"
            : "必要信息还未确定，你想先保留目标，之后再完善吗？";
          reply.reason = "已知与未知分别保留，不会强行继续追问或安排日历。";
        }
        reply.requested_slot = target;
        reply.stage =
          after.some(
            (s) => s.key === "outcome" && s.value.state === "confirmed",
          ) &&
          after.some(
            (s) => s.key === "available_time" && s.value.state === "confirmed",
          )
            ? "research_ready"
            : target === null
              ? "needs_information"
              : "clarifying";
      }
      inputTokens = completion.inputTokens;
      outputTokens = completion.outputTokens;
      const normalized = (s: string) => s.replace(/[\s，。?？!！]/g, "");
      if (
        reply.requested_slot === undefined &&
        history.results.some(
          (r) =>
            normalized(JSON.parse(r.reply_json as string).question) ===
            normalized(reply.question),
        )
      )
        throw new AgentError("AI_REPEATED_QUESTION");
    }
    if (controller.signal.aborted) throw new AgentError("AI_TIMEOUT");
    const planningNotes = stop
      ? (
          await db
            .prepare(
              "SELECT user_text FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.source')='deepseek' ORDER BY turn_index DESC LIMIT 8",
            )
            .bind(goalId, owner)
            .all()
        ).results
          .map((r) => String(r.user_text))
          .filter(
            (t) =>
              ![
                "请根据我的目标和已确认条件，提出一个必要的澄清问题。",
                "请继续问我一个有助于完善方案的问题。",
                "请继续澄清仍未明确的条件。",
              ].includes(t),
          )
          .reverse()
          .map((t) => t.slice(0, 200))
      : [];
    if (text.startsWith(answerStopPrefix))
      planningNotes.push(text.slice(answerStopPrefix.length).slice(0, 200));
    while (planningNotes.length > 8) planningNotes.shift();
    const completed = Date.now();
    await db.batch([
      db
        .prepare(
          "UPDATE agent_runs SET status='succeeded',reply_json=?,input_tokens=?,output_tokens=?,updated_at=? WHERE id=? AND owner_id=? AND status='running' AND lease_until>? AND EXISTS(SELECT 1 FROM goals WHERE id=goal_id AND owner_id=? AND status='draft' AND revision=? AND (active_plan_version_id IS NULL OR ?=0)) AND NOT EXISTS(SELECT 1 FROM agent_runs p WHERE p.goal_id=agent_runs.goal_id AND p.owner_id=agent_runs.owner_id AND p.status='succeeded' AND json_extract(p.reply_json,'$.source')='policy' AND ?=1)",
        )
        .bind(
          JSON.stringify(reply),
          inputTokens,
          outputTokens,
          completed,
          id,
          owner,
          completed,
          owner,
          goalRevision,
          capture ? 1 : 0,
          capture ? 1 : 0,
        ),
      ...(stop && reply.stage === "draft_requested"
        ? planningStatements(
            db,
            id,
            goalId,
            owner,
            goalRevision,
            {
              schema_version: 1,
              generation_mode: "chat_auto_v1",
              goal: {
                description: String(
                  contextGoal.description || contextGoal.title,
                ),
                timeframe_note: String(contextGoal.timeframe_note),
              },
              dialogue_notes: planningNotes,
              conditions: ["outcome", "available_time", "constraints"].map(
                (key) => {
                  const saved = slots.results.find((s) => s.key === key);
                  return {
                    key,
                    source: "user",
                    confirmed_at: saved?.confirmed_at ?? null,
                    value: saved
                      ? JSON.parse(String(saved.value_json))
                      : { schema_version: 1, state: "unknown", text: "" },
                  };
                },
              ),
            },
            completed,
          )
        : []),
      ...(capture
        ? captureStatements(
            db,
            capture,
            id,
            goalId,
            owner,
            goalRevision,
            completed,
          )
        : []),
      db
        .prepare(
          "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'assistant',reply_json,updated_at FROM agent_runs WHERE id=? AND owner_id=? AND status='succeeded'",
        )
        .bind(crypto.randomUUID(), id, owner),
    ]);
    const result = await db
      .prepare("SELECT status FROM agent_runs WHERE id=? AND owner_id=?")
      .bind(id, owner)
      .first();
    if (result?.status !== "succeeded") throw new AgentError("CONTEXT_CHANGED");
    if (stop) await dispatchForRun(id);
    return ok(await snapshot());
  } catch (error) {
    const code = error instanceof AgentError ? error.code : "AI_UNAVAILABLE";
    await db
      .prepare(
        "UPDATE agent_runs SET status='failed',error_code=?,updated_at=? WHERE id=? AND owner_id=? AND status='running'",
      )
      .bind(code, Date.now(), id, owner)
      .run();
    return fail(code === "CONTEXT_CHANGED" ? 409 : 502, code);
  } finally {
    clearTimeout(timer!);
  }
}
