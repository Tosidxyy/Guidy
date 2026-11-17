import { describe, expect, it } from 'vitest';
import { createProjector } from '../qca/project';
const seqFactory = () => { let n = 100; return () => ++n; };
const DELTA_SEQ = 7;
describe('projector', () => {
  it('content_delta 增量投影为 delta 事件（固定 deltaSeq）并累积文本', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const a = p.push({ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: '你' } } });
    const b = p.push({ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: '好' } } });
    expect(a[0]).toMatchObject({ event: 'delta', data: { seq: DELTA_SEQ, text: '你' } });
    expect(b[0].data).toMatchObject({ seq: DELTA_SEQ, text: '好' });
    expect(p.text()).toBe('你好');
  });
  it('已流式输出后，缓冲 agent.message 不再重复发 delta', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    p.push({ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '你好' } } });
    const out = p.push({ type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '你好' }] });
    expect(out).toHaveLength(0);
    expect(p.text()).toBe('你好');
  });
  it('无流式 delta 时，缓冲消息发一条完整 delta', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '完整回复' }] });
    expect(out[0]).toMatchObject({ event: 'delta', data: { seq: DELTA_SEQ, text: '完整回复' } });
  });
  it('session idle → completed 终态（递增 seq）', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'session.status', status: 'idle' });
    expect(out[0]).toMatchObject({ event: 'status', data: { state: 'completed' } });
    expect(out[0].data.seq).toBeGreaterThan(DELTA_SEQ);
    expect(p.isTerminal()).toBe(true);
  });
  it('session error → failed 终态，不被后续 idle 翻转为成功', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    p.push({ type: 'session.error' });
    const out = p.push({ type: 'session.status', status: 'idle' });
    expect(out[0]).toMatchObject({ event: 'status', data: { state: 'failed' } });
  });
  it('event_start 不产生事件', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    expect(p.push({ type: 'event_start', id: 'e1' })).toHaveLength(0);
  });
});
describe('projector — QCA 真实生命周期事件（状态编码在 type 名中）', () => {
  it('session.status_idle → completed 终态', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'session.status_idle', id: 'evt_x', processed_at: '2026-11-16T00:00:00Z' });
    expect(out[0]).toMatchObject({ event: 'status', data: { state: 'completed' } });
    expect(p.isTerminal()).toBe(true);
  });
  it('session.status_running → 非终态，无事件', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    expect(p.push({ type: 'session.status_running' })).toHaveLength(0);
    expect(p.isTerminal()).toBe(false);
  });
  it('session.thread_status_idle → 非终态（thread 级，session 仍可能继续）', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    expect(p.push({ type: 'session.thread_status_idle' })).toHaveLength(0);
    expect(p.isTerminal()).toBe(false);
  });
  it('session.status_terminated → 终态', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'session.status_terminated' });
    expect(out[0]).toMatchObject({ event: 'status', data: { state: 'completed' } });
    expect(p.isTerminal()).toBe(true);
  });
  it('session.deleted → 终态', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'session.deleted' });
    expect(out[0]).toMatchObject({ event: 'status' });
    expect(p.isTerminal()).toBe(true);
  });
  it('session.error 后 session.status_idle → failed，不翻转为成功', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    p.push({ type: 'session.error' });
    const out = p.push({ type: 'session.status_idle' });
    expect(out[0]).toMatchObject({ event: 'status', data: { state: 'failed' } });
  });
  it('完整真实事件流：running→delta→buffered→idle 累积文本并终态', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    expect(p.push({ type: 'session.status_running' })).toHaveLength(0);
    p.push({ type: 'event_start', event: { id: 'e1', type: 'agent.message' } });
    p.push({ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: '你好' } } });
    p.push({ type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '你好' }] });
    expect(p.isTerminal()).toBe(false);
    const out = p.push({ type: 'session.status_idle' });
    expect(out[0]).toMatchObject({ event: 'status', data: { state: 'completed' } });
    expect(p.text()).toBe('你好');
    expect(p.isTerminal()).toBe(true);
  });
});
describe('projector — 研究工具事件投影', () => {
  it('agent.tool_use(WebSearch) → progress，仅工具名，不泄露 input，非终态', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'agent.tool_use', id: 'evt_t', name: 'WebSearch', input: { query: '秘密搜索词' }, evaluated_permission: 'allow' });
    expect(out[0]).toMatchObject({ event: 'progress', data: { seq: DELTA_SEQ, tool: 'WebSearch' } });
    expect(JSON.stringify(out)).not.toContain('秘密搜索词');
    expect(p.isTerminal()).toBe(false);
  });
  it('agent.tool_use(WebFetch) → progress', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'agent.tool_use', id: 'evt_t', name: 'WebFetch', input: { url: 'https://x' } });
    expect(out[0]).toMatchObject({ event: 'progress', data: { tool: 'WebFetch' } });
  });
  it('白名单外工具名忽略', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    expect(p.push({ type: 'agent.tool_use', id: 'evt_t', name: 'Bash', input: {} })).toHaveLength(0);
  });
  it('requires_action → error 而非 completed（终态 failed）', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['evt_t'] } });
    expect(out[0]).toMatchObject({ event: 'error', data: { code: 'tool_confirmation_unsupported' } });
    expect(p.isTerminal()).toBe(true);
    expect(out.some((e) => e.event === 'status')).toBe(false);
  });
});