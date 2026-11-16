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