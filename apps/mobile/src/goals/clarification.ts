export const questions = [
  { key: 'outcome', label: '期望结果', question: '怎样才算达成这个目标？', hint: '例如：能在旅行时进行简单英语交流。' },
  { key: 'available_time', label: '可投入时间', question: '你能投入多少时间？', hint: '例如：工作日晚上，每次 20 分钟。' },
  { key: 'constraints', label: '限制条件', question: '有什么需要考虑的限制？', hint: '例如：预算有限，或只能在家完成。' },
] as const;
export type SlotInput = { key: typeof questions[number]['key']; state: 'confirmed' | 'unknown'; text: string };
export type SavedSlot = { key: SlotInput['key']; value: { schema_version: 1; state: SlotInput['state']; text: string }; source: 'user'; confirmed_at: number | null };
export function emptySlots(): SlotInput[] {
  return questions.map(q => ({ key: q.key, state: 'unknown', text: '' }));
}
export function checkedSlots(value: unknown): SavedSlot[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error('条件响应格式不正确。');
  const seen = new Set();
  for (const s of value) {
    if (!s || !questions.some(q => q.key === s.key) || seen.has(s.key) || s.source !== 'user' || s.value?.schema_version !== 1 || !['confirmed','unknown'].includes(s.value.state) || typeof s.value.text !== 'string' || s.value.text.length > 300 || (s.value.state === 'confirmed' ? !s.value.text.trim() || !Number.isSafeInteger(s.confirmed_at) || s.confirmed_at < 0 : s.value.text !== '' || s.confirmed_at !== null)) throw new Error('条件响应格式不正确。');
    seen.add(s.key);
  }
  return value;
}
