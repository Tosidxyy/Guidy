import type { D1Database } from "@cloudflare/workers-types";

const commands = new Set([
  "请根据我的目标和已确认条件，提出一个必要的澄清问题。",
  "请继续问我一个有助于完善方案的问题。",
  "请继续澄清仍未明确的条件。",
  "先到这里，请根据现有信息准备方案草稿。",
  "请根据现有信息直接拟定一周安排。",
  "我想调整未来的安排。",
  "请重新检查这份调整的日程。",
  "请帮我按每周频次预览首阶段一周。",
  "确认这些时段，按频次试排首阶段一周，同项每天最多一次。",
  "请帮我预览首阶段各项一次的具体时间。",
  "确认这些时段，预览首阶段各项一次。",
  "请帮我记录已有占用。",
  "确认保存这些已有占用。",
]);
export async function questionHistoryResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
) {
  const url = new URL(request.url),
    goalId = url.pathname.split("/").at(-2)!;
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: {
          code,
          message: "回答历史暂时未能读取，请重试。",
          details: null,
        },
        request_id: requestId,
      },
      { status },
    );
  if (request.method !== "GET") {
    const response = fail(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", "GET");
    return response;
  }
  const raw = url.searchParams.get("before");
  const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
  if (
    url.searchParams.size > (raw === null ? 0 : 1) ||
    (raw !== null && !/^[1-9]\d{0,15}$/.test(raw)) ||
    !Number.isSafeInteger(before) ||
    before < 1
  )
    return fail(422, "HISTORY_CURSOR_INVALID");
  if (
    !(await db
      .prepare("SELECT id FROM goals WHERE id=? AND owner_id=?")
      .bind(goalId, owner)
      .first())
  )
    return fail(404, "NOT_FOUND");
  const rows = (
    await db
      .prepare(
        `SELECT r.id,r.turn_index,json_extract(r.reply_json,'$.question') question,
    (SELECT n.user_text FROM agent_runs n WHERE n.goal_id=r.goal_id AND n.owner_id=r.owner_id AND n.turn_index>r.turn_index ORDER BY n.turn_index LIMIT 1) answer
    FROM agent_runs r WHERE r.goal_id=? AND r.owner_id=? AND r.turn_index<? AND r.status='succeeded'
    AND json_extract(r.reply_json,'$.kind') IN ('question','referral') ORDER BY r.turn_index DESC LIMIT 21`,
      )
      .bind(goalId, owner, before)
      .all()
  ).results;
  const cards = rows
    .slice(0, 20)
    .reverse()
    .map((row) => {
      const rawAnswer = row.answer as string | null;
      return {
        id: row.id,
        turn_index: Number(row.turn_index),
        question: row.question,
        answer:
          rawAnswer && !commands.has(rawAnswer)
            ? rawAnswer.replace(/^根据当前回答开始制订：/, "")
            : null,
      };
    });
  return Response.json(
    {
      data: {
        goal_id: goalId,
        cards,
        next_before: rows.length > 20 ? cards[0].turn_index : null,
      },
      error: null,
      request_id: requestId,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
