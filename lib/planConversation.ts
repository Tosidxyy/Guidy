export interface ConversationLike { id: string; plan_id: string | null; status?: string }

// items 须已按 updated_at desc 排序（listConversations 保证）；取首个 plan_id 严格相等匹配。
export function conversationForPlan(items: ConversationLike[], planId: string | null): ConversationLike | null {
  return items.find((c) => c.plan_id === planId) ?? null;
}