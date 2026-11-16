import { describe, expect, it } from 'vitest';
import { parseModelText } from '../artifacts';
import { buildSystemPrompt, buildUserMessage } from '../prompt';
const validSet = { type: 'constraint_set', plan_title: '考研冲刺', horizon_days: 7, task_defs: [{ key: 'math', title: '数学真题', category: 'study', duration_min: 90, frequency: { type: 'daily' } }], constraints: [], clarifications_needed: [] };
describe('artifacts', () => {
  it('解析裸 JSON constraint_set', () => {
    const r = parseModelText(JSON.stringify(validSet));
    expect(r?.kind).toBe('constraint_set');
  });
  it('解析 ```json 围栏', () => {
    const r = parseModelText('前言\n```json\n' + JSON.stringify(validSet) + '\n```\n后语');
    expect(r?.kind).toBe('constraint_set');
  });
  it('解析 patch', () => {
    const r = parseModelText(JSON.stringify({ type: 'patch', summary: '移动数学', ops: [{ op: 'move_block', id: 'b1', start_utc: '2026-11-17T01:00:00Z', end_utc: '2026-11-17T02:30:00Z' }] }));
    expect(r?.kind).toBe('patch');
  });
  it('普通文本 → null', () => { expect(parseModelText('你好，请告诉我你的目标')).toBeNull(); });
  it('非法 JSON → null', () => { expect(parseModelText('{bad')).toBeNull(); });
  it('schema 不合法 → null', () => { expect(parseModelText(JSON.stringify({ type: 'constraint_set', task_defs: [] }))).toBeNull(); });
  it('prompt 含关键约束词', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('constraint_set');
    expect(p).toContain('clarifications_needed');
  });
  it('buildUserMessage 无计划时提示生成', () => {
    expect(buildUserMessage({ message: '排个计划', plan: null, history: [] })).toContain('constraint_set');
  });
});