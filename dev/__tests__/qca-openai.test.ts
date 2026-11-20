import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiQca } from '../qca-openai';
import { readSSE } from '../../functions/qca/sse.mjs';

const ENDPOINT = 'http://llm.local/v1/chat/completions';

function sseResponse(chunks: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const toolCallChunk = {
  choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'WebSearch', arguments: '{"query":"北京 明天 天气"}' } }] } }],
};
const contentChunk = (text: string) => ({ choices: [{ delta: { content: text } }] });

async function runTurn(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const qca = createOpenAiQca({ baseUrl: 'http://llm.local/v1', apiKey: 'k', model: 'm' });
  const binding = await qca.ensureBinding('scope');
  const session = await qca.createSession(binding, 't', {});
  const stream = await qca.openStream(session.id, {});
  await qca.sendEvents(session.id, '明天北京天气如何，适合跑步吗');
  const events: any[] = [];
  for await (const f of readSSE(stream.body)) events.push(JSON.parse(f.data));
  return events;
}

afterEach(() => vi.unstubAllGlobals());

describe('本地检索循环', () => {
  it('tool_calls 触发 WebSearch 执行并把结果回灌模型，UI 收到 tool_use 事件', async () => {
    const bodies: any[] = [];
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (url === ENDPOINT) {
        bodies.push(JSON.parse(init.body));
        return bodies.length === 1 ? sseResponse([toolCallChunk]) : sseResponse([contentChunk('明天晴，适合跑步。')]);
      }
      return new Response('<a class="result__a" href="https://weather.example/bj">北京天气</a><a class="result__snippet">明天晴 20 度</a>', { headers: { 'content-type': 'text/html' } });
    });
    const events = await runTurn(fetchMock);
    expect(events.some((e) => e.type === 'agent.tool_use' && e.name === 'WebSearch')).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('duckduckgo'))).toBe(true);
    const second = bodies[1];
    expect(second.messages.some((m: any) => m.role === 'tool' && String(m.content).includes('weather.example'))).toBe(true);
    const final = events.find((e) => e.type === 'agent.message');
    expect(final.content[0].text).toContain('适合跑步');
  });

  it('搜索源不可用时回灌诚实声明，不中断对话', async () => {
    const bodies: any[] = [];
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (url === ENDPOINT) {
        bodies.push(JSON.parse(init.body));
        return bodies.length === 1 ? sseResponse([toolCallChunk]) : sseResponse([contentChunk('当前无法联网核实，先按假设安排。')]);
      }
      throw new Error('network blocked');
    });
    const events = await runTurn(fetchMock);
    const toolMsg = bodies[1].messages.find((m: any) => m.role === 'tool');
    expect(String(toolMsg.content)).toContain('联网搜索当前不可用');
    expect(events.find((e) => e.type === 'agent.message').content[0].text).toContain('无法联网');
    expect(events.some((e) => e.type === 'session.status' && e.status === 'idle')).toBe(true);
  });
});