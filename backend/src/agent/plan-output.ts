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
  const tool = {
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
        time_preferences: object({
          timezone: { type: "string", enum: ["Asia/Shanghai", "UTC"] },
          start_minute: { type: "integer", minimum: 0, maximum: 1439 },
          end_minute: { type: "integer", minimum: 5, maximum: 1440 },
          excluded_weekdays: array(
            { type: "integer", minimum: 0, maximum: 6 },
            "0为周日到6为周六，不重复；是待确认的建议，不是真实空闲声明",
          ),
        }),
        stage_weeks: array(
          object({
            stage: { type: "integer", enum: [1, 2, 3] },
            weeks: {
              type: "integer",
              minimum: 1,
              maximum: data.planning_contract === "strategy_21_v1" ? 1 : 12,
            },
          }),
          data.planning_contract === "strategy_21_v1"
            ? "恰好三个阶段1,2,3，每阶段weeks=1，总计21天"
            : "按阶段升序列出每个实际任务阶段的周数，总计最多12周",
        ),
        tasks: array(
          object({
            key: { type: "string", enum: ["t1", "t2", "t3", "t4", "t5", "t6"] },
            stage: { type: "integer", enum: [1, 2, 3] },
            title: string(80),
            instructions: string(400),
            segments: array(
              object({
                title: string(40),
                instructions: string(120),
                duration_minutes: { type: "integer", minimum: 1, maximum: 120 },
              }),
              "每次任务按先后拆成1到3段可执行做法，各段分钟数之和必须等于本任务duration_minutes；通常2到3段，做法简洁",
            ),
            duration_minutes: { type: "integer", minimum: 5, maximum: 120 },
            frequency_per_week: { type: "integer", minimum: 1, maximum: 7 },
            mandatory: { type: "boolean" },
            depends_on: array(
              { type: "string", enum: ["t1", "t2", "t3", "t4", "t5", "t6"] },
              data.planning_contract === "strategy_21_v1"
                ? "只允许更早阶段的前置任务key，同阶段必须独立；每次的先后步骤放segments"
                : "最多5项前置任务key，不可自依赖/成环",
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
  if (data.planning_contract === "strategy_21_v1") {
    const properties = tool.function.parameters.properties;
    const task = properties.tasks as {
      items: { properties: Record<string, unknown> };
    };
    const {
      key: _key,
      stage: _stage,
      depends_on: _deps,
      ...content
    } = task.items.properties;
    void _key;
    void _stage;
    void _deps;
    // The application owns the 3 x 7-day structure. The model fills one
    // practice unit per week; ordered actions belong to its segments.
    properties.tasks = object({
      week1: object(content),
      week2: object(content),
      week3: object(content),
    });
    delete properties.stage_weeks;
    tool.function.parameters.required = Object.keys(properties);
  }
  return tool;
}

export function normalizePlanOutput(content: string, context: string): string {
  if (JSON.parse(context).planning_contract !== "strategy_21_v1")
    return content;
  const value = JSON.parse(content);
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "assumptions,risks,summary,tasks,time_preferences,title" ||
    !value.tasks ||
    Object.keys(value.tasks).sort().join(",") !== "week1,week2,week3"
  )
    throw new Error("Invalid strategy carrier");
  for (const unit of Object.values(value.tasks))
    if (
      !unit ||
      Object.keys(unit).sort().join(",") !==
        "duration_minutes,evidence_ids,frequency_per_week,instructions,mandatory,segments,title"
    )
      throw new Error("Invalid strategy unit");
  return JSON.stringify({
    ...value,
    stage_weeks: [1, 2, 3].map((stage) => ({ stage, weeks: 1 })),
    tasks: [1, 2, 3].map((stage) => ({
      ...value.tasks[`week${stage}`],
      key: `t${stage}`,
      stage,
      depends_on: [],
    })),
  });
}
