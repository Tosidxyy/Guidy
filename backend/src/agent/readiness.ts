type Condition = {
  key: string;
  source: string;
  confirmed_at: unknown;
  value: { schema_version: number; state: string; text: string };
};
const keys = ["outcome", "available_time", "constraints"] as const;
export function clarificationReadiness(
  goal: {
    revision: number;
    status: string;
    description?: string;
    title?: string;
  },
  slots: Condition[],
  policyNotice: boolean,
) {
  const confirmed = keys.filter((key) =>
    slots.some(
      (s) =>
        s.key === key &&
        s.source === "user" &&
        s.value.schema_version === 1 &&
        s.value.state === "confirmed" &&
        typeof s.value.text === "string" &&
        !!s.value.text.trim() &&
        s.value.text.length <= 300 &&
        Number.isSafeInteger(s.confirmed_at) &&
        Number(s.confirmed_at) >= 0,
    ),
  );
  const missing = ["outcome", "available_time"].filter(
    (key) => !confirmed.includes(key as (typeof keys)[number]),
  );
  // This conservative gate is not a comprehensive medical-risk classifier.
  const facts = [
    goal.description || goal.title || "",
    ...slots.map((s) => s.value.text),
  ]
    .join("\n")
    .replace(/没有(?:已知)?伤病|无伤病/g, "");
  const needsReview =
    policyNotice ||
    /处方|停药|减药|增药|药物剂量|药量|诊断|自杀|自残|伤害他人|伤病|怀孕|糖尿病|心脏病/i.test(
      facts,
    );
  return {
    schema_version: 1 as const,
    goal_revision: goal.revision,
    phase:
      goal.status === "paused"
        ? "paused"
        : goal.status !== "draft"
          ? "read_only"
          : needsReview
            ? "needs_review"
            : missing.length
              ? "needs_confirmation"
              : "research_preparation",
    confirmed_keys: confirmed,
    missing_required: missing,
    unknown_optional: confirmed.includes("constraints") ? [] : ["constraints"],
  };
}
