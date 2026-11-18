import { describe, expect, it } from 'vitest';
import { parseModelText } from '../artifacts';
import { buildSystemPrompt, buildUserMessage, CONSTRAINT_SET_EXAMPLE } from '../prompt';
import { ConstraintSetArtifactSchema } from '../../shared/schemas';
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
  it('patch 的 op 使用 type 字段时归一化为 op', () => {
    const r = parseModelText(JSON.stringify({ type: 'patch', summary: '清空', ops: [{ type: 'clear_plan' }] }));
    expect(r?.kind).toBe('patch');
    if (r?.kind === 'patch') expect(r.value.ops[0].op).toBe('clear_plan');
  });
  it('解析 clear_plan', () => {
    const r = parseModelText(JSON.stringify({ type: 'patch', summary: '清空', ops: [{ op: 'clear_plan' }] }));
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
});

describe('prompt 对话策略 — 自由对话 agent，意图分流', () => {
  it('系统指令声明可自由对话并守卫身份', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('自由对话');
    expect(p).toContain('不透露底层模型');
  });
  it('与排程无关时不输出产物', () => {
    expect(buildSystemPrompt()).toContain('不输出任何产物');
  });
  it('信息不足用自然语言追问，每轮最多 2 个', () => {
    expect(buildSystemPrompt()).toContain('每轮最多 2 个');
  });
  it('信息足够才生成 constraint_set', () => {
    expect(buildSystemPrompt()).toContain('才输出 constraint_set');
  });
  it('范例标注仅示范形状、禁止照抄', () => {
    expect(buildSystemPrompt()).toContain('禁止照抄范例');
  });
  it('buildUserMessage 无计划时不强制生成产物', () => {
    const m = buildUserMessage({ message: '你是什么模型', plan: null, history: [] });
    expect(m).not.toContain('请生成 constraint_set');
    expect(m).toContain('当前对话还没有计划');
  });
  it('方案未落库时的修改仍要求完整 constraint_set，不输出 patch', () => {
    expect(buildSystemPrompt()).toContain('不要输出 patch');
    const m = buildUserMessage({ message: '周末改上午', plan: null, history: [] });
    expect(m).toContain('不要输出 patch');
    expect(m).toContain('尚未落库');
  });
  it('声明 horizon_start 与「下周」的时间基准', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('horizon_start');
    expect(p).toContain('今天是 YYYY-MM-DD');
    expect(p).toContain('下一个自然周的周一');
  });
  it('patch 契约要求 op 字段，并给出 clear_plan 示例', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('不是 "type"');
    expect(p).toContain('"op":"clear_plan"');
    expect(p).toContain('不要把 ops 数组直接作为顶层输出');
  });
  it('buildUserMessage 注入今天与星期，供模型换算相对日期', () => {
    const m = buildUserMessage({ message: '从下周开始', plan: null, history: [], today: '2026-11-18', timezone: 'Asia/Shanghai' });
    expect(m).toContain('今天是 2026-11-18（周三，Asia/Shanghai）');
  });
  it('计划上下文包含 task key / constraint id / block id，禁止 AI 猜 key', () => {
    const plan = {
      plan: { id: 'p1', title: '测试计划', horizon_start: '2026-11-23', horizon_days: 7 as const, timezone: 'Asia/Shanghai', status: 'active' as const, version: 1, created_at: '', updated_at: '' },
      task_defs: [{ key: 'warmup', title: '热身', category: 'fitness' as const, duration_min: 5, frequency: { type: 'daily' as const }, priority: 'mid' as const, splittable: false, sort_order: 0 }],
      constraints: [{ id: 'c-1', payload: { type: 'active_window' as const, start: '07:00', end: '23:00' }, source: 'user' as const, enabled: true }],
      blocks: [{ id: 'blk-1', task_key: 'warmup', title: '热身', category: 'fitness' as const, start_utc: '2026-11-23T00:00:00.000Z', end_utc: '2026-11-23T00:05:00.000Z', priority: 'mid' as const, pinned: false, origin: 'engine' as const }],
    };
    const m = buildUserMessage({ message: '清空计划', plan, history: [] });
    expect(m).toContain('warmup｜热身');
    expect(m).toContain('c-1｜');
    expect(m).toContain('blk-1｜热身｜2026-11-23');
    expect(buildSystemPrompt()).toContain('禁止根据标题猜测');
    expect(buildSystemPrompt()).toContain('删除全部计划');
  });
});

describe('prompt 契约 — 范例必须与引擎/确认卡消费的 schema 完全一致', () => {
  it('内嵌范例可被 ConstraintSetArtifactSchema 解析', () => {
    const r = ConstraintSetArtifactSchema.safeParse(CONSTRAINT_SET_EXAMPLE);
    expect(r.success).toBe(true);
  });
  it('范例覆盖 AI 易错的四类约束', () => {
    const types = CONSTRAINT_SET_EXAMPLE.constraints.map((c) => c.type);
    for (const t of ['daily_cap', 'busy_window', 'mutex', 'preferred_period']) expect(types).toContain(t);
  });
  it('system prompt 逐字内嵌该范例供 AI 参照', () => {
    expect(buildSystemPrompt()).toContain(JSON.stringify(CONSTRAINT_SET_EXAMPLE, null, 2));
  });
  it('system prompt 锁定易错字段名与枚举', () => {
    const p = buildSystemPrompt();
    for (const token of ['max_minutes', 'subjects', 'no_adjacent', 'high|mid|low', '{type:"daily"}', 'per_week', 'weekday', 'strength']) {
      expect(p).toContain(token);
    }
  });
});

describe('prompt 研究式规划指引 — 用户不知道做什么时联网检索', () => {
  it('声明研究式规划并点名 WebSearch/WebFetch', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('研究式规划');
    expect(p).toContain('WebSearch');
    expect(p).toContain('WebFetch');
  });
  it('要求把来源依据写进正文，不暴露原始搜索词', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('来源');
    expect(p).toContain('不要暴露原始搜索词');
  });
  it('检索无果回退自身知识，适度搜索不拖延', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('回退自身知识');
    expect(p).toContain('不要过度搜索');
  });
});