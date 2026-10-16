import type { D1Database } from "@cloudflare/workers-types";
import type { SlotSuggestion } from "./suggestions.ts";
export type CaptureKey = "outcome" | "available_time" | "constraints";
export type CaptureValue = {
  schema_version: 1;
  state: "confirmed" | "unknown";
  text: string;
};
export type Capture = {
  key: CaptureKey;
  value: CaptureValue;
  evidence: string;
  questionRunId: string;
};
export type ChatCondition = { key: string; value: CaptureValue };
export const TIME_PROPOSAL_TEXT = "愿意先尝试每周60分钟；具体可用时段尚未确认";
export function delegatesTime(text: string): boolean {
  return /^(?:你来安排|你安排|你帮我安排|你来决定|你决定|由你安排|你看着安排|帮我安排)(?:吧|就好|就行)?[。！!]?$/u.test(
    text.trim(),
  );
}
export function nextChatSlot(
  conditions: ChatCondition[],
  revisitUnknown = false,
): CaptureKey | null {
  if (revisitUnknown)
    for (const key of ["outcome", "available_time"] as const)
      if (
        !conditions.some((s) => s.key === key && s.value.state === "confirmed")
      )
        return key;
  for (const key of ["outcome", "available_time", "constraints"] as const)
    if (!conditions.some((s) => s.key === key)) return key;
  return null;
}
export function nextCoreQuestion(
  asked: readonly string[],
  conditions: ChatCondition[],
  revisitUnknown = false,
): CaptureKey | null {
  return (
    (["outcome", "available_time", "constraints"] as const).find(
      (key) => !asked.includes(key),
    ) ?? (revisitUnknown ? nextChatSlot(conditions, true) : null)
  );
}
export function safeChatAnswer(text: string): boolean {
  return (
    !!text.trim() &&
    text.length <= 300 &&
    !/[?？\p{Cc}\p{Cf}]/u.test(text) &&
    !/不确定|不知道|不清楚|没想好|也许|可能|大概|或者|还是|帮我|请你|请帮|忽略|系统指令|搜索|生成方案|安排日历|我想问|换个问题|改(?:成|为|一下)|改目标|不是|更正|其实|不对|取消|删除|怎样|怎么|为何|为什么/.test(
      text,
    )
  );
}
export function chatCapture(
  text: string,
  suggestions: SlotSuggestion[],
  previous: {
    id: string;
    goal_revision: number;
    requested_slot?: CaptureKey | null;
    source: string;
    time_proposal?: "weekly_60_v1";
  } | null,
  revision: number,
  conditions: ChatCondition[],
): Capture | null {
  const key = previous?.requested_slot;
  if (
    !key ||
    previous.source !== "deepseek" ||
    previous.goal_revision !== revision ||
    conditions.some((s) => s.key === key && s.value.state === "confirmed")
  )
    return null;
  if (
    key === "available_time" &&
    previous.time_proposal === "weekly_60_v1" &&
    /^(?:是|是的|可以|行|好|好的|愿意|愿意尝试|接受|同意|按这个来|就这样|没问题)[。！!]?$/u.test(
      text,
    )
  )
    return {
      key,
      value: {
        schema_version: 1,
        state: "confirmed",
        text: TIME_PROPOSAL_TEXT,
      },
      evidence: text,
      questionRunId: previous.id,
    };
  const unknown =
    (key === "available_time" && delegatesTime(text)) ||
    (previous.time_proposal === "weekly_60_v1" &&
      /^(?:不|不接受|不同意|太多了?|暂时不决定|先不决定)[。！!]?$/u.test(
        text,
      )) ||
    /^(?:暂不确定(?:，请考虑其他必要条件。)?|不知道|不清楚|没想好)[。！!]?$/u.test(
      text,
    );
  if (unknown && text.length <= 300) {
    if (conditions.some((s) => s.key === key && s.value.state === "unknown"))
      return null;
    return {
      key,
      value: { schema_version: 1, state: "unknown", text: "" },
      evidence: text,
      questionRunId: previous.id,
    };
  }
  // Only a complete explicit answer to the latest targeted question may be admitted.
  // Partial quotes, inferred facts and corrections are not automatically confirmed.
  if (
    !safeChatAnswer(text) ||
    !suggestions.some(
      (s) => s.key === key && s.text === text && s.evidence === text,
    )
  )
    return null;
  return {
    key,
    value: { schema_version: 1, state: "confirmed", text },
    evidence: text,
    questionRunId: previous.id,
  };
}
export function captureStatements(
  db: D1Database,
  capture: Capture,
  runId: string,
  goalId: string,
  owner: string,
  revision: number,
  now: number,
) {
  const marker = `chat-capture:${runId}`,
    value = JSON.stringify(capture.value);
  return [
    db
      .prepare(
        "UPDATE goals SET revision=revision+1,updated_at=max(updated_at,?),last_mutation_key=? WHERE id=? AND owner_id=? AND revision=? AND status='draft' AND active_plan_version_id IS NULL AND EXISTS(SELECT 1 FROM agent_runs WHERE id=? AND owner_id=? AND status='succeeded')",
      )
      .bind(now, marker, goalId, owner, revision, runId, owner),
    db
      .prepare(
        "INSERT INTO goal_slots(id,goal_id,key,value_json,confirmed_at,updated_at) SELECT ?,id,?,?,?,? FROM goals WHERE id=? AND owner_id=? AND revision=? AND last_mutation_key=? ON CONFLICT(goal_id,key) DO UPDATE SET value_json=excluded.value_json,confirmed_at=excluded.confirmed_at,updated_at=excluded.updated_at",
      )
      .bind(
        crypto.randomUUID(),
        capture.key,
        value,
        capture.value.state === "confirmed" ? now : null,
        now,
        goalId,
        owner,
        revision + 1,
        marker,
      ),
    db
      .prepare(
        "INSERT INTO chat_condition_captures(run_id,question_run_id,goal_id,owner_id,slot_key,value_json,evidence,extraction_version,resulting_goal_revision,created_at) SELECT ?,?,id,owner_id,?,?,?,'chat-capture-v1',revision,? FROM goals WHERE id=? AND owner_id=? AND revision=? AND last_mutation_key=?",
      )
      .bind(
        runId,
        capture.questionRunId,
        capture.key,
        value,
        capture.evidence,
        now,
        goalId,
        owner,
        revision + 1,
        marker,
      ),
  ];
}
