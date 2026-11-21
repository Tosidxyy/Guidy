import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca, upstreamStream } from '../../dev/fake-qca';
import { readSSE } from '../qca/sse.mjs';
import type { Deps, RouteCtx } from '../types';

function deps(qcaOverrides = {}): Deps {
  return {
    db: createMemoryDb(),
    requireUser: () => { throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); },
    qca: createFakeQca(qcaOverrides),
    config: { cloudApiOrigin: 'x', appScope: 'scope', modelId: 'm' },
  };
}
function ctx(body: unknown): RouteCtx {
  return { request: new Request('http://127.0.0.1:8000/functions/v1/app/api/ai/chat', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) };
}
async function collect(res: Response) {
  const out: any[] = [];
  for await (const f of readSSE(res.body!)) out.push({ event: f.event, data: JSON.parse(f.data) });
  return out;
}

const NL = String.fromCharCode(10);
const wrap = (prose: string, artifact: unknown) => [prose, '```json', JSON.stringify(artifact), '```'].join(NL);

const plan = {
  plan: { id: 'p1', title: '大三两周', horizon_start: '2026-11-23', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 120, frequency: { type: 'daily' } }],
  constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
  blocks: [{ id: 'b1', task_key: 'math', title: '数学', category: 'study', start_utc: '2026-11-23T00:00:00.000Z', end_utc: '2026-11-23T02:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' }],
};
// 公共日历里的「杭州旅游」大块：11-28 08:00–22:00 本地。
const tripBlock = { id: 'sb-trip', title: '杭州旅游', category: 'life', start_utc: '2026-11-28T00:00:00.000Z', end_utc: '2026-11-28T14:00:00.000Z', priority: 'high', pinned: false, origin: 'manual' };
const child = (title: string, s: string, e: string) => ({ op: 'add_block', value: { title, category: 'life', start_utc: `2026-11-28T${s}:00.000Z`, end_utc: `2026-11-28T${e}:00.000Z`, priority: 'mid', pinned: false } });
const removeTrip = { op: 'remove_block', id: 'sb-trip', date: '2026-11-28', title: '杭州旅游' };
const children = [child('灵隐寺', '01:00', '03:00'), child('西湖漫步', '05:00', '08:00')];

const base = {
  text: '细化杭州旅游那天', conversation_id: 'c1', request_id: 'r1', seq_base: 0,
  today: '2026-11-23', timezone: 'Asia/Shanghai', plan, plans: [], sharedBlocks: [tripBlock], history: [],
};

function scripted(responses: string[]) {
  let opens = 0;
  const d = deps({ openStream: async () => {
    const text = responses[Math.min(opens, responses.length - 1)];
    opens += 1;
    return { body: upstreamStream([
      { type: 'agent.message', id: 'e1', content: [{ type: 'text', text }] },
      { type: 'session.status', status: 'idle' },
    ]), close() {} };
  } });
  return { d, opens: () => opens };
}

describe('正文承诺与产物一致性（细化=替换）', () => {
  it('内部工具标记不是成功回复：自动修正且不泄漏到正文', async () => {
    const good = wrap('已将原块替换为具体行程。', { type: 'patch', summary: '细化旅游', ops: [removeTrip, ...children] });
    const { d, opens } = scripted(['<｜DSML｜tool_call>WebFetch</｜DSML｜tool_call>', good]);
    const frames = await collect(await application(d)(ctx(base)));
    expect(opens()).toBe(2);
    expect(frames.some(f => f.event === 'artifact' && f.data.kind === 'patch')).toBe(true);
    expect(frames.filter(f => f.event === 'delta').some(f => f.data.text.includes('DSML'))).toBe(false);
  });

  it('工具标记连续无效则明确失败，不发出可应用产物', async () => {
    const { d, opens } = scripted(['<｜DSML｜calls>bad</｜DSML｜calls>']);
    const frames = await collect(await application(d)(ctx(base)));
    expect(opens()).toBe(3);
    expect(frames.some(f => f.event === 'artifact')).toBe(false);
    expect(frames.some(f => f.event === 'error' && f.data.code === 'artifact_invalid')).toBe(true);
  });

  it('正文每周6次与任务5次不符：退回修正为实际频次', async () => {
    const artifact = { type: 'constraint_set', plan_title: '健身', horizon_days: 7, task_defs: [{ key: 'fit', title: '健身', category: 'fitness', duration_min: 30, frequency: { type: 'per_week', count: 5 } }], constraints: [], clarifications_needed: [] };
    const { d, opens } = scripted([wrap('健身每周6次。', artifact), wrap('健身每周5次。', artifact)]);
    const frames = await collect(await application(d)(ctx({ ...base, plan: null, sharedBlocks: [], text: '帮我安排健身' })));
    expect(opens()).toBe(2);
    expect(frames.find(f => f.event === 'artifact')?.data.kind).toBe('constraint_set');
    expect(frames.filter(f => f.event === 'delta').at(-1)?.data.text).toContain('每周5次');
  });

  it('固定家教与已有数学冲突：只输出追问，不能静默生成重叠方案', async () => {
    const artifact = { type: 'constraint_set', plan_title: '家教', horizon_start: '2026-11-23', horizon_days: 7,
      task_defs: [{ key: 'tutor', title: '家教', category: 'work', duration_min: 60, frequency: { type: 'once' } }],
      constraints: [{ type: 'fixed_block', date: '2026-11-23', start: '08:30', end: '09:30', title: '家教', category: 'work' }], clarifications_needed: [] };
    const { d } = scripted([wrap('家教安排好了。', artifact)]);
    const frames = await collect(await application(d)(ctx({ ...base, plan: null, plans: [plan], sharedBlocks: [], text: '11月23日8点半家教，别和其他安排冲突' })));
    const art = frames.find(f => f.event === 'artifact');
    expect(art?.data.kind).toBe('question_card');
    expect(art?.data.payload.questions[0].text).toContain('数学');
    expect(art?.data.payload.questions[0].text).toContain('2026-11-23');
  });

  it('说拆掉原块却只加不删 → 退回修正一次，补上 remove_block 后通过', async () => {
    const addOnly = wrap('我把「杭州旅游」拆分为具体行程：上午灵隐寺、下午西湖。', { type: 'patch', summary: '细化杭州', ops: children });
    const fixed = wrap('已删除原「杭州旅游」大块，替换为具体行程。', { type: 'patch', summary: '细化杭州', ops: [removeTrip, ...children] });
    const { d, opens } = scripted([addOnly, fixed]);
    const frames = await collect(await application(d)(ctx(base)));
    expect(opens()).toBe(2);
    const art = frames.find((f) => f.event === 'artifact');
    expect(art?.data.kind).toBe('patch');
    expect(art?.data.payload.ops.some((o: any) => o.op === 'remove_block' && o.id === 'sb-trip')).toBe(true);
    expect(frames.some((f) => f.event === 'status' && f.data.state === 'completed')).toBe(true);
  });

  it('修正后仍只加不删 → 明确失败，不发出可应用的重叠产物', async () => {
    const addOnly = wrap('我把「杭州旅游」拆分为具体行程。', { type: 'patch', summary: '细化杭州', ops: children });
    const { d, opens } = scripted([addOnly]);
    const frames = await collect(await application(d)(ctx(base)));
    expect(opens()).toBe(3);
    expect(frames.some(f => f.event === 'artifact')).toBe(false);
    expect(frames.some(f => f.event === 'error' && f.data.code === 'artifact_invalid')).toBe(true);
    const finalText = frames.filter(f => f.event === 'delta').at(-1)?.data.text ?? '';
    expect(finalText).toContain('原块仍会留在日历上');
    expect(finalText).toContain('重叠');
  });

  it.each(['搬家', '考试周复习'])('%s 一次事件细化复用替换契约，不保留原块', async title => {
    const block = { ...tripBlock, title };
    const artifact = { type: 'patch', summary: `细化${title}`, ops: [{ op: 'remove_block', id: block.id }, child('第一阶段', '01:00', '03:00'), child('第二阶段', '05:00', '08:00')] };
    const { d, opens } = scripted([wrap(`删除原「${title}」，换成两个具体阶段。`, artifact)]);
    const frames = await collect(await application(d)(ctx({ ...base, text: `把${title}这一天规划详细`, sharedBlocks: [block] })));
    expect(opens()).toBe(1);
    const art = frames.find(f => f.event === 'artifact');
    expect(art?.data.payload.ops[0]).toMatchObject({ op: 'remove_block', id: block.id });
    expect(art?.data.preview.notes).toEqual([]);
  });

  it('正确替换公共日历大块：共享块 id 不算 missing，一轮完成且无警告', async () => {
    const good = wrap('已删除原「杭州旅游」大块，替换为上午灵隐寺、下午西湖两段行程。', { type: 'patch', summary: '细化杭州', ops: [removeTrip, ...children] });
    const { d, opens } = scripted([good]);
    const frames = await collect(await application(d)(ctx(base)));
    expect(opens()).toBe(1);
    const art = frames.find((f) => f.event === 'artifact');
    expect(art?.data.kind).toBe('patch');
    expect(art?.data.preview?.notes ?? []).toHaveLength(0);
    expect(frames.some((f) => f.event === 'error')).toBe(false);
  });

  it('新引入的重叠 → 退回修正；改对后通过', async () => {
    const overlapping = wrap('给你加两段安排。', { type: 'patch', summary: '加安排', ops: [child('灵隐寺', '00:30', '02:30')] });
    const fixed = wrap('已把原来的安排替换为灵隐寺行程。', { type: 'patch', summary: '加安排', ops: [removeTrip, child('灵隐寺', '01:00', '03:00')] });
    const { d, opens } = scripted([overlapping, fixed]);
    const frames = await collect(await application(d)(ctx(base)));
    expect(opens()).toBe(2);
    const art = frames.find((f) => f.event === 'artifact');
    expect(art?.data.preview?.notes ?? []).toHaveLength(0);
  });

  it('说挪动却没有对应操作 → 退回修正一次', async () => {
    const emptyPromise = wrap('好的，把数学挪到晚上7点以后。', { type: 'patch', summary: '挪数学', ops: [{ op: 'update_task_def', key: 'math', patch: { notes: '晚上' } }] });
    const fixed = wrap('把数学挪到晚上7点以后。', { type: 'patch', summary: '挪数学', ops: [{ op: 'move_block', id: 'b1', task_key: 'math', date: '2026-11-23', title: '数学', start_utc: '2026-11-23T11:00:00.000Z', end_utc: '2026-11-23T13:00:00.000Z' }] });
    const { d, opens } = scripted([emptyPromise, fixed]);
    const frames = await collect(await application(d)(ctx({ ...base, text: '把数学挪到晚上7点以后' })));
    // update_task_def 属于规则修改但没有 reschedule，也没有块操作 → 视为空头承诺。
    expect(opens()).toBe(2);
    const art = frames.find((f) => f.event === 'artifact');
    expect(art?.data.payload.ops[0].op).toBe('move_block');
  });

  it('大量深夜块 → 退回修正；坚持深夜则 notes 提示确认作息', async () => {
    const nightOps = ['24', '25', '26'].map((d) => ({ op: 'add_block', value: { title: '吉他', category: 'creative', start_utc: `2026-11-${d}T16:00:00.000Z`, end_utc: `2026-11-${d}T16:30:00.000Z`, priority: 'mid', pinned: false } }));
    const night = wrap('已把吉他安排在凌晨。', { type: 'patch', summary: '凌晨吉他', ops: nightOps });
    const { d, opens } = scripted([night]);
    const frames = await collect(await application(d)(ctx({ ...base, text: '每天凌晨练吉他' })));
    expect(opens()).toBe(3);
    const art = frames.find((f) => f.event === 'artifact');
    const notes: string[] = art?.data.preview?.notes ?? [];
    expect(notes.some((n) => n.includes('深夜'))).toBe(true);
  });
});