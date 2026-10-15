export type QuestionCard = { id: string; turn_index: number; question: string; answer: string | null };
export type QuestionHistory = { goal_id: string; cards: QuestionCard[]; next_before: number | null };
export function checkedHistory(value: QuestionHistory, goal: string, before = Number.MAX_SAFE_INTEGER): QuestionHistory {
  if (!value || value.goal_id !== goal || !Array.isArray(value.cards) || value.cards.length > 20 ||
    value.cards.some((c, i) => !c || !/^[0-9a-f-]{36}$/.test(c.id) || !Number.isSafeInteger(c.turn_index) || c.turn_index < 1 || c.turn_index >= before ||
      (i > 0 && c.turn_index <= value.cards[i - 1].turn_index) || typeof c.question !== 'string' || !c.question.trim() || c.question.length > 240 ||
      (c.answer !== null && (typeof c.answer !== 'string' || c.answer.length > 500))) ||
    new Set(value.cards.map(c => c.id)).size !== value.cards.length ||
    (value.next_before !== null && (value.cards.length !== 20 || value.next_before !== value.cards[0].turn_index))) throw new Error('回答历史格式不正确，请重新读取。');
  return value;
}
