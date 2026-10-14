// Output carrier only. emit_plan is never dispatched or executed as a tool.
export function planOutputTool(context: string) {
  let data;
  try {
    data = JSON.parse(context);
  } catch {
    throw new Error("Invalid plan context");
  }
  const refs = data?.sources?.map(
    (s: { evidence_ref?: unknown }) => s.evidence_ref,
  );
  if (
    !Array.isArray(refs) ||
    (refs.length < 1 && data.generation_mode !== "chat_auto_v1") ||
    refs.length > 3 ||
    new Set(refs).size !== refs.length ||
    refs.some((ref) => typeof ref !== "string" || !/^E[1-3]$/.test(ref))
  )
    throw new Error("Invalid plan context");
  const object = (properties: Record<string, unknown>) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const string = (max: number) => ({
    type: "string",
    pattern: `^[\\s\\S]{1,${max}}$`,
  });
  const array = (items: unknown, description: string) => ({
    type: "array",
    items,
    description,
  });
  return {
    type: "function",
    function: {
      name: "emit_plan",
      description:
        "Return one unconfirmed plan draft as structured data; perform no action.",
      strict: true,
      parameters: object({
        title: string(80),
        summary: string(300),
        assumptions: array(string(160), "最多5条未知/待确认假设，可为空"),
        risks: array(string(160), "最多5条风险/限制，可为空"),
        stage_weeks: array(
          object({
            stage: { type: "integer", enum: [1, 2, 3] },
            weeks: { type: "integer", minimum: 1, maximum: 12 },
          }),
          "按阶段升序列出每个实际任务阶段的周数，总计最多12周；结合用户目标和期望周期，不确定时在假设里说明",
        ),
        tasks: array(
          object({
            key: { type: "string", enum: ["t1", "t2", "t3", "t4", "t5", "t6"] },
            stage: { type: "integer", enum: [1, 2, 3] },
            title: string(80),
            instructions: string(400),
            duration_minutes: { type: "integer", minimum: 5, maximum: 120 },
            frequency_per_week: { type: "integer", minimum: 1, maximum: 7 },
            mandatory: { type: "boolean" },
            depends_on: array(
              { type: "string", enum: ["t1", "t2", "t3", "t4", "t5", "t6"] },
              "最多5项前置任务key，不可自依赖/成环",
            ),
            evidence_ids: array(
              refs.length
                ? { type: "string", enum: refs }
                : { type: "string", pattern: "^$" },
              "最多3项当前来源引用，至少一个任务有引用",
            ),
          }),
          "1到6个任务，key不重复",
        ),
      }),
    },
  };
}
