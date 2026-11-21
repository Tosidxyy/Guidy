import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca, upstreamStream } from '../../dev/fake-qca';
import { readSSE } from '../qca/sse.mjs';
import { reduceFrame, initialChatState } from '../../store/useChatStore';
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

const P = '按 3 个月倒排：前 4 周补文献。每周实验 3 次、每次 100 分钟，文献 2 次、每次 60 分钟。';
const bad = { type: 'constraint_set', plan_title: '论文', horizon_days: 7, task_defs: [{ key: 'exp', title: '实验', category: 'study', duration_min: 90, frequency: { type: 'daily' } }], constraints: [{ type: 'active_window', start: '07:00', end: '08:00' }], clarifications_needed: [] };
const good = { ...bad, task_defs: [{ key: 'exp', title: '实验', category: 'study', duration_min: 30, frequency: { type: 'daily' } }] };
const json = (s: unknown) => '\n```json\n' + JSON.stringify(s) + '\n```';

const body = { text: '三个月论文计划，直接给方案', conversation_id: 'c-dup', request_id: 'req-dup', today: '2026-11-20', timezone: 'Asia/Shanghai', plan: null, plans: [], sharedBlocks: [], history: [] };

function bubbleTexts(frames: any[]) {
  let st: any = { ...initialChatState, messages: [] };
  for (const f of frames) st = reduceFrame(st, f as any);
  return st.messages.filter((m: any) => m.role === 'assistant' && m.kind === 'text').map((m: any) => m.content);
}

describe('重试轮 prose 单气泡', () => {
  it('只有问题卡 JSON 时生成真实问题提示，不回用旧的承诺正文', async () => {
    const card = { type: 'question_card', title: '请确认', questions: [{ text: '这次想调整哪个安排？', options: ['数学', '英语'] }] };
    const d = deps({ openStream: async () => ({ body: upstreamStream([
      { type: 'agent.message', id: 'q', content: [{ type: 'text', text: json(card) }] },
      { type: 'session.status', status: 'idle' },
    ]), close() {} }) });
    const frames = await collect(await application(d)(ctx(body)));
    expect(bubbleTexts(frames)).toEqual(['需要先确认：这次想调整哪个安排？']);
    expect(frames.find(f => f.event === 'artifact')?.data.kind).toBe('question_card');
  });

  it('单纯调整产物的摘要末尾不叠加句号，也不提前宣称已经保存', async () => {
    const patch = { type: 'patch', summary: '移动英语。', ops: [{ op: 'update_task_def', key: 'english', patch: { duration_min: 30 } }] };
    const d = deps({ openStream: async () => ({ body: upstreamStream([
      { type: 'agent.message', id: 'p', content: [{ type: 'text', text: json(patch) }] },
      { type: 'session.status', status: 'idle' },
    ]), close() {} }) });
    const frames = await collect(await application(d)(ctx(body)));
    const texts = bubbleTexts(frames);
    expect(texts).toEqual(['调整建议：移动英语。请确认后应用。']);
    expect(texts[0]).not.toContain('。。');
    expect(texts[0]).not.toContain('已按');
  });

  it('修复轮只输出 JSON 时，终局 flush 复用同一气泡而不是再发一遍全文', async () => {
    let n = 0;
    const d = deps({ openStream: async () => {
      n += 1;
      const frames = n === 1
        ? [{ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: P + json(bad) } } }]
        : [{ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: json(good) } } }];
      return { body: upstreamStream([...frames, { type: 'session.status', status: 'idle' }]), close() {} };
    } });
    const frames = await collect(await application(d)(ctx(body)));
    expect(n).toBe(2);
    const seqs = new Set(frames.filter((f) => f.event === 'delta').map((f) => f.data.seq));
    expect(seqs.size).toBe(1);
    expect(bubbleTexts(frames)).toEqual(['方案已生成，请在方案卡核对实际排程后确认。']);
  });
  it('修复轮 prose 变短时，只展示最终轮正文且仍只有一个气泡', async () => {
    let n = 0;
    const d = deps({ openStream: async () => {
      n += 1;
      const text = n === 1 ? P + json(bad) : '精简版。' + json(good);
      return { body: upstreamStream([
        { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text } } },
        { type: 'session.status', status: 'idle' },
      ]), close() {} };
    } });
    const frames = await collect(await application(d)(ctx(body)));
    expect(n).toBe(2);
    expect(bubbleTexts(frames)).toEqual(['精简版。']);
  });
});
describe('整天不可用日/照抄既有安排 → 自动修正一轮', () => {
  it('首版把共享旅游日复制进新计划时重试修正，而不是直接问用户', async () => {
    const shared = [{ id: 's-trip', title: '出发去车站', category: 'life', start_utc: '2026-11-27T23:00:00.000Z', end_utc: '2026-11-28T01:00:00.000Z', priority: 'mid', pinned: true, origin: 'manual', unavailable_date: '2026-11-28' }];
    const badSet = { type: 'constraint_set', plan_title: '吉他', horizon_start: '2026-11-27', horizon_days: 3, task_defs: [{ key: 'g', title: '吉他', category: 'creative', duration_min: 30, frequency: { type: 'daily' } }], constraints: [{ type: 'fixed_block', title: '杭州旅游', category: 'life', date: '2026-11-28', start: '07:00', end: '08:00' }], clarifications_needed: [] };
    const goodSet = { ...badSet, constraints: [] };
    let n = 0;
    const d = deps({ openStream: async () => {
      n += 1;
      const set = n === 1 ? badSet : goodSet;
      return { body: upstreamStream([
        { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '安排吉他。\n```json\n' + JSON.stringify(set) + '\n```' } } },
        { type: 'session.status', status: 'idle' },
      ]), close() {} };
    } });
    const frames = await collect(await application(d)(ctx({ ...body, sharedBlocks: shared })));
    // 契约层守卫直接忽略复制的固定占用：首轮即出产物，不再问用户。
    expect(n).toBe(1);
    const art = frames.find((f) => f.event === 'artifact' && f.data.kind === 'constraint_set');
    expect(art).toBeTruthy();
    expect(art.data.payload.constraints).toHaveLength(0);
    expect((art.data.preview?.notes ?? []).some((t: string) => t.includes('已忽略'))).toBe(true);
    expect(frames.some((f) => f.event === 'artifact' && f.data.kind === 'question_card')).toBe(false);
  });
});

describe('频率+时长的排程请求只回文字时要求补产物', () => {
  it('每天练 30 分钟吉他这类请求不允许纯文字收尾', async () => {
    let n = 0;
    const d = deps({ openStream: async () => {
      n += 1;
      const text = n === 1 ? '好的，我会把吉他绕开家教时段安排。' : '安排如下。\n```json\n' + JSON.stringify({ type: 'constraint_set', plan_title: '吉他', horizon_days: 7, task_defs: [{ key: 'g', title: '吉他', category: 'creative', duration_min: 30, frequency: { type: 'daily' } }], constraints: [], clarifications_needed: [] }) + '\n```';
      return { body: upstreamStream([
        { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text } } },
        { type: 'session.status', status: 'idle' },
      ]), close() {} };
    } });
    const frames = await collect(await application(d)(ctx({ ...body, text: '我每周二、周四下午 1 点到 4 点要去做家教，另外每天想练 30 分钟吉他，别和我其他安排冲突' })));
    expect(n).toBe(2);
    expect(frames.some((f) => f.event === 'artifact' && f.data.kind === 'constraint_set')).toBe(true);
  });
});

describe('冲突问题卡补齐标准解决路径', () => {
  it('模型自拟选项保留，同时补三条标准选项', async () => {
    const qc = { type: 'question_card', title: '家教时段怎么避让', questions: [{ text: '周二周四 13:00–16:00 家教与数学重叠，怎么调？', options: ['数学家教各自挪', '家教改到晚上'] }, { text: '吉他放哪个时段？', options: ['晚上', '上午'] }] };
    const d = deps({ openStream: async () => ({ body: upstreamStream([
      { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '先确认冲突。\n```json\n' + JSON.stringify(qc) + '\n```' } } },
      { type: 'session.status', status: 'idle' },
    ]), close() {} }) });
    const frames = await collect(await application(d)(ctx(body)));
    const art = frames.find((f) => f.event === 'artifact' && f.data.kind === 'question_card');
    expect(art.data.payload.questions[0].options).toEqual(['先调整已有安排', '修改新安排的时间', '暂不添加新安排', '数学家教各自挪']);
    expect(art.data.payload.questions[1].options).toEqual(['晚上', '上午']);
  });
});

describe('空 ops patch 按纯文本回复', () => {
  it('寒暄收到空 patch 时不弹调整卡', async () => {
    const d = deps({ openStream: async () => ({ body: upstreamStream([
      { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '```json\n' + JSON.stringify({ type: 'patch', summary: '你好，我是 Guidy。', ops: [] }) + '\n```' } } },
      { type: 'session.status', status: 'idle' },
    ]), close() {} }) });
    const frames = await collect(await application(d)(ctx({ ...body, text: '你好，请只用一句话打个招呼，不要创建或修改任何计划，也不要调用工具。' })));
    expect(frames.some((f) => f.event === 'artifact')).toBe(false);
    expect(frames.some((f) => f.event === 'delta' && f.data.text.includes('你好，我是 Guidy'))).toBe(true);
    expect(frames.some((f) => f.event === 'status' && f.data.state === 'completed')).toBe(true);
  });
});

describe('纯 no-op patch 按纯文本回复', () => {
  it('update_plan 改回原标题不产生调整卡', async () => {
    const plan = { plan: { id: 'p1', title: '考研计划', horizon_start: '2026-11-21', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' }, task_defs: [], constraints: [], blocks: [] };
    const d = deps({ openStream: async () => ({ body: upstreamStream([
      { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '```json\n' + JSON.stringify({ type: 'patch', summary: '你好，我是 Guidy。', ops: [{ op: 'update_plan', patch: { title: '考研计划' } }] }) + '\n```' } } },
      { type: 'session.status', status: 'idle' },
    ]), close() {} }) });
    const frames = await collect(await application(d)(ctx({ ...body, plan, text: '你好，请只用一句话打个招呼，不要创建或修改任何计划，也不要调用工具。' })));
    expect(frames.some((f) => f.event === 'artifact')).toBe(false);
    expect(frames.some((f) => f.event === 'delta' && f.data.text.includes('你好，我是 Guidy'))).toBe(true);
  });
});
