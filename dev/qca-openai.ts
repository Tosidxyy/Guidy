import type { QcaAdapter } from '../functions/types.ts';
import { buildSystemPrompt } from '../functions/prompt.ts';
import { encodeSSE } from '../functions/qca/sse.mjs';

export interface LocalLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface Turn {
  message?: string;
  waiter?: (message: string) => void;
}

interface CompletionChunk {
  choices?: { delta?: { content?: string }; message?: { content?: string } }[];
}

// OpenAI 兼容的本地 QCA 替身：把 functions/prompt.ts 的系统提示交给真实模型，
// 再把回复包装成 app 消费的 QCA 事件流。密钥只在本地 Function 进程内使用。
export function createOpenAiQca(config: LocalLlmConfig): QcaAdapter {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const turns = new Map<string, Turn>();
  // QCA 的会话自带上下文；直连 OpenAI 兼容接口是无状态的，这里按 session 保留最近对话。
  const histories = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();

  async function complete(sessionId: string, message: string, signal: AbortSignal | undefined, onDelta: (text: string) => void): Promise<string> {
    const history = [...(histories.get(sessionId) ?? [])];
    const last = history.at(-1);
    if (last?.role !== 'user' || last.content !== message) history.push({ role: 'user', content: message });
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          ...history,
        ],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`llm_http_${res.status}`);
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const json = (await res.json()) as CompletionChunk;
      const text = json.choices?.[0]?.message?.content ?? '';
      if (text) onDelta(text);
      histories.set(sessionId, [...history, { role: 'assistant', content: text }].slice(-20));
      return text;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let json: CompletionChunk;
          try { json = JSON.parse(data) as CompletionChunk; } catch { continue; }
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (!delta) continue;
          full += delta;
          onDelta(delta);
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (full) histories.set(sessionId, [...history, { role: 'assistant', content: full }].slice(-20));
    return full;
  }

  return {
    async ensureBinding() { return { agent: { type: 'agent', id: 'local-openai', version: 1 }, environment_id: 'local' }; },
    async createSession() { return { id: `local-${crypto.randomUUID()}` }; },
    async sendEvents(sessionId, text) {
      const turn = turns.get(sessionId) ?? {};
      if (turn.waiter) {
        const waiter = turn.waiter;
        turns.delete(sessionId);
        waiter(text);
      } else {
        turns.set(sessionId, { message: text });
      }
      return { eventIds: ['local-event'] };
    },
    async openStream(sessionId, opts) {
      // chatSend 先 openStream 再 sendEvents，因此这里先挂起，等本轮用户消息到达后再请求模型。
      const pending = new Promise<string>((resolve) => {
        const turn = turns.get(sessionId) ?? {};
        if (turn.message !== undefined) {
          const message = turn.message;
          turns.delete(sessionId);
          resolve(message);
          return;
        }
        turn.waiter = resolve;
        turns.set(sessionId, turn);
      });
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const message = await pending;
            if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
            const full = await complete(sessionId, message, opts.signal, (text) => {
              controller.enqueue(encodeSSE('event_delta', { type: 'event_delta', event_id: 'local', delta: { type: 'content_delta', content: { type: 'text', text } } }));
            });
            controller.enqueue(encodeSSE('agent.message', { type: 'agent.message', id: 'local', content: [{ type: 'text', text: full }] }));
            controller.enqueue(encodeSSE('session.status', { type: 'session.status', status: 'idle' }));
          } catch {
            if (!opts.signal?.aborted) controller.enqueue(encodeSSE('session.error', { type: 'session.error', status: 'failed' }));
          } finally {
            controller.close();
          }
        },
      });
      return { body, close() {} };
    },
    async listEvents() { return { data: [], has_more: false }; },
  };
}