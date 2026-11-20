import { describe, expect, it, vi, afterEach } from 'vitest';
import { createOpenAiQca } from '../qca/openai';
import { createResilientQca } from '../qca/fallback';
import { createMemoryDb } from '../../dev/fake-db';
import { readSSE } from '../qca/sse.mjs';
import type { Db } from '../db';

function sseResponse(chunks: unknown[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body } as unknown as Response;
}
const delta = (text: string) => ({ choices: [{ delta: { content: text } }] });

afterEach(() => vi.unstubAllGlobals());

async function drain(stream: { body: ReadableStream<Uint8Array> }) {
  const out: any[] = [];
  for await (const f of readSSE(stream.body)) out.push(JSON.parse(f.data));
  return out;
}

describe('createOpenAiQca（DB 历史）', () => {
  it('createSession 绑定 conversation_id；第二轮请求携带第一轮助手回复且不含重复本轮用户消息', async () => {
    const db = createMemoryDb();
    await db.from('conversations').insert({ id: 'conv-1', owner_visitor_id: 'v', title: 't', qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' }).select('id');
    await db.from('messages').insert({ conversation_id: 'conv-1', seq: 1, role: 'user', kind: 'text', content: '第一问原文' }).select('id');
    await db.from('messages').insert({ conversation_id: 'conv-1', seq: 2, role: 'assistant', kind: 'text', content: '第一轮助手回复' }).select('id');
    await db.from('messages').insert({ conversation_id: 'conv-1', seq: 3, role: 'user', kind: 'text', content: '第二问原文' }).select('id');
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return sseResponse([delta('好的'), delta('第二轮')]);
    }));
    const qca = createOpenAiQca({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-chat' }, db as Db);
    const binding = await qca.ensureBinding('scope');
    const session = await qca.createSession(binding, 't', { conversation_id: 'conv-1', visitor_id: 'v' });
    expect(session.id).toBe('local-conv-1');
    const st = await qca.openStream(session.id, {});
    await qca.sendEvents(session.id, '第二问完整prompt', 'key-1');
    const events = await drain(st);
    expect(events.some((e) => e.type === 'agent.message')).toBe(true);
    expect(events.some((e) => e.type === 'session.status' && e.status === 'idle')).toBe(true);
    const msgs = bodies[0].messages;
    expect(msgs.some((m: any) => m.role === 'assistant' && m.content === '第一轮助手回复')).toBe(true);
    expect(msgs.some((m: any) => m.role === 'user' && m.content === '第一问原文')).toBe(true);
    expect(msgs.filter((m: any) => m.role === 'user' && m.content === '第二问原文')).toHaveLength(0);
    expect(msgs.at(-1)).toMatchObject({ role: 'user', content: '第二问完整prompt' });
  });

  it('429 → failover 到下一家并下发 provider.switch', async () => {
    const db = createMemoryDb();
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 429 } as Response;
      return sseResponse([delta('兜底回复')]);
    }));
    const a = createOpenAiQca({ baseUrl: 'https://a/v1', apiKey: 'k', model: 'm' }, db as Db);
    const b = createOpenAiQca({ baseUrl: 'https://b/v1', apiKey: 'k', model: 'm' }, db as Db);
    const qca = createResilientQca([{ name: 'deepseek', adapter: a }, { name: 'bailian', adapter: b }]);
    const binding = await qca.ensureBinding('scope');
    const session = await qca.createSession(binding, 't', { conversation_id: 'conv-x' });
    const st = await qca.openStream(session.id, {});
    await qca.sendEvents(session.id, '问', 'key-2');
    const events = await drain(st);
    expect(events.some((e) => e.type === 'provider.switch')).toBe(true);
    expect(events.some((e) => e.type === 'agent.message' && e.content[0].text === '兜底回复')).toBe(true);
  });
});