import { AgentError } from "./provider.ts";

export type SlotSuggestion = {
  key: "outcome" | "available_time" | "constraints";
  text: string;
  evidence: string;
};

// Suggestions quote this turn's user input. Classification still requires user review.
export function checkedSuggestions(
  value: unknown,
  userText: string,
): SlotSuggestion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3)
    throw new AgentError("AI_INVALID_RESPONSE");
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some((k) => !["key", "text", "evidence"].includes(k)) ||
      !["outcome", "available_time", "constraints"].includes(item.key) ||
      seen.has(item.key) ||
      typeof item.text !== "string" ||
      !item.text.trim() ||
      item.text.length > 300 ||
      item.text !== item.text.trim() ||
      item.evidence !== item.text ||
      !userText.includes(item.evidence)
    )
      throw new AgentError("AI_INVALID_RESPONSE");
    seen.add(item.key);
  }
  return value as SlotSuggestion[];
}
