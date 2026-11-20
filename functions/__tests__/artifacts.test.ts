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

  describe('输出被截断的兜底（长计划常见）', () => {
    const big = {
      type: 'constraint_set', plan_title: '雅思三个月', horizon_days: 90,
      task_defs: [
        { key: 'vocab', title: '背单词', category: 'study', duration_min: 30, frequency: { type: 'daily' } },
        { key: 'listening', title: '听力精听', category: 'study', duration_min: 45, frequency: { type: 'per_week', count: 5 } },
      ],
      constraints: [{ type: 'daily_cap', category: 'study', max_minutes: 180 }],
      clarifications_needed: [],
    };
    const full = JSON.stringify(big);
    it('第二个任务写到一半被截断 → 丢掉半截任务仍可解析', () => {
      const cut = full.indexOf('"listening"') + 40;
      const r = parseModelText('前言两句话。\n```json\n' + full.slice(0, cut));
      expect(r?.kind).toBe('constraint_set');
      if (r?.kind === 'constraint_set') {
        expect(r.value.task_defs.length).toBe(1);
        expect(r.value.task_defs[0].key).toBe('vocab');
        expect(r.value.plan_title).toBe('雅思三个月');
      }
    });
    it('截断在字符串（notes）内部 → 闭合字符串后仍可解析', () => {
      const withNotes = JSON.stringify({ ...big, task_defs: [{ ...big.task_defs[0], notes: '每天用 App 背 50 个新词并复习前一天的错词库' }] });
      const cut = withNotes.indexOf('复习前一天的错词库') + 3;
      const r = parseModelText(withNotes.slice(0, cut));
      expect(r?.kind).toBe('constraint_set');
      if (r?.kind === 'constraint_set') expect(r.value.task_defs[0].key).toBe('vocab');
    });
    it('patch 的 ops 截断 → 保留完整 ops，丢弃半截 op', () => {
      const p = JSON.stringify({ type: 'patch', summary: '调整', ops: [
        { op: 'move_block', id: 'b1', start_utc: '2026-11-17T01:00:00Z', end_utc: '2026-11-17T02:00:00Z' },
        { op: 'remove_block', id: 'b2' },
      ] });
      const cut = p.indexOf('"b2"') + 3;
      const r = parseModelText(p.slice(0, cut));
      expect(r?.kind).toBe('patch');
      if (r?.kind === 'patch') {
        expect(r.value.ops.length).toBe(1);
        expect(r.value.ops[0].op).toBe('move_block');
      }
    });
    it('还没写出任何 task 就被截断 → null（不伪造空计划）', () => {
      const cut = full.indexOf('"task_defs":[') + 13;
      expect(parseModelText(full.slice(0, cut))).toBeNull();
    });
    it('普通文本里的残缺 JSON 片段不会误判', () => {
      expect(parseModelText('我打算用 {"type":"patch" 的方式说明，但这不是产物')).toBeNull();
      expect(parseModelText('今天聊点别的：{"foo":1')).toBeNull();
    });
  });
  it('截止日硬护栏：horizon 取 ≥ 剩余天数的最小档位', () => {
    const withDeadline = (horizon_days: number, date: string, horizon_start?: string) => ({
      ...validSet, horizon_days, horizon_start,
      constraints: [{ type: 'deadline', date, label: '初试' }],
    });
    const span = (r: ReturnType<typeof parseModelText>) => (r?.kind === 'constraint_set' ? r.value.horizon_days : null);
    expect(span(parseModelText(JSON.stringify(withDeadline(90, '2026-12-15')), '2026-11-19'))).toBe(27);
    expect(span(parseModelText(JSON.stringify(withDeadline(30, '2026-11-23')), '2026-11-19'))).toBe(5);
    expect(span(parseModelText(JSON.stringify(withDeadline(7, '2027-01-18')), '2026-11-19'))).toBe(61);
    expect(span(parseModelText(JSON.stringify(withDeadline(90, '2026-12-15', '2026-12-01')), '2026-11-19'))).toBe(15);
    expect(span(parseModelText(JSON.stringify(withDeadline(30, '2026-11-01')), '2026-11-19'))).toBe(30);
    expect(span(parseModelText(JSON.stringify({ ...validSet, horizon_days: 90 }), '2026-11-19'))).toBe(90);
  });
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
  it('阻塞项合并单轮追问，最多 3 问', () => {
    expect(buildSystemPrompt()).toContain('最多 3 问');
    expect(buildSystemPrompt()).toContain('不再追加第二轮');
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

describe('question_card 产物', () => {
  it('能把追问卡片解析为 question_card', () => {
    const card = { type: 'question_card', title: '还需要确认', questions: [{ text: '每周练几天？', options: ['3 练', '6 练'] }] };
    const parsed = parseModelText('```json\n' + JSON.stringify(card) + '\n```');
    expect(parsed?.kind).toBe('question_card');
    expect((parsed as any).value.questions).toHaveLength(1);
  });
  it('选项少于 2 个或问题为空时拒绝', () => {
    expect(parseModelText(JSON.stringify({ type: 'question_card', questions: [] }))).toBeNull();
    expect(parseModelText(JSON.stringify({ type: 'question_card', questions: [{ text: 'x', options: ['只有一个'] }] }))).toBeNull();
  });
});
describe('prompt 联网检索 — 默认不搜，先判断必要性', () => {
  it('要求先判断是否需要检索，排程请求不搜', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('默认不搜');
    expect(p).toContain('先判断');
    expect(p).toContain('排程类请求');
    expect(p).toContain('一律不搜');
  });
  it('检索仅限会变化的外部事实，最多一次', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('外部可核实且会变化的事实');
    expect(p).toContain('最多 1 次');
    expect(p).toContain('通用知识');
  });
  it('要求把来源依据写进正文，不暴露原始搜索词', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('来源');
    expect(p).toContain('不要暴露原始搜索词');
  });
  it('结果不足立即停止检索，直接给方案', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('结果不足时立刻停止检索');
  });
});