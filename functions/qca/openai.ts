import type { QcaAdapter } from '../types.ts';
import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { buildSystemPrompt } from '../prompt.ts';
import { encodeSSE } from './sse.mjs';

export interface LocalLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单轮输出上限。长计划（3 个月、多任务）需要更多 token，1800 会在 JSON 中途截断。 */
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 3200;

interface Turn {
  message?: string;
  waiter?: (message: string) => void;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface CompletionChunk {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  }[];
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MAX_TOOL_ROUNDS = 1;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'WebSearch',
      description: '搜索互联网，返回最多 6 条标题/链接/摘要。需要外部事实（天气、日期、政策、价格等）时先搜再答。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索词' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebFetch',
      description: '抓取一个公开 http(s) 网页并返回正文文本（截断至 6000 字）。用于核实搜索结果的细节。',
      parameters: { type: 'object', properties: { url: { type: 'string', description: '完整 URL' } }, required: ['url'] },
    },
  },
];

function isPublicUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return false;
  }
  if (h === '[::1]' || h.startsWith('[fc') || h.startsWith('[fd')) return false;
  return true;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface SearchHit { title: string; url: string; snippet: string }

async function searchSource(url: string, re: RegExp): Promise<SearchHit[]> {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) return [];
  const html = await res.text();
  const hits: SearchHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < 6) {
    const href = m[1];
    if (!href.startsWith('http')) continue;
    hits.push({ title: stripHtml(m[2]).slice(0, 120), url: href, snippet: stripHtml(m[3] ?? '').slice(0, 220) });
  }
  return hits;
}

async function webSearch(query: string): Promise<string> {
  // 搜索在工具轮里执行，期间没有 SSE 帧：必须并行且短超时，否则 15s 空闲保护会把整个回合掐掉。
  const q = encodeURIComponent(query);
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/g;
  const bingRe = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
  const settled = await Promise.allSettled([
    searchSource(`https://html.duckduckgo.com/html/?q=${q}`, blockRe),
    searchSource(`https://www.bing.com/search/?q=${q}`, bingRe),
  ]);
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value.length) return JSON.stringify({ results: s.value });
  }
  return JSON.stringify({ results: [], note: '联网搜索当前不可用（网络受限）。不要声称检索过；如需外部事实，向用户追问或明说假设。' });
}

async function webFetch(url: string): Promise<string> {
  if (!isPublicUrl(url)) return JSON.stringify({ error: '仅允许公开 http(s) 地址' });
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
    if (!res.ok) return JSON.stringify({ error: `http_${res.status}` });
    const html = await res.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
    return JSON.stringify({ title: stripHtml(title).slice(0, 120), text: stripHtml(html).slice(0, 6000) });
  } catch (e) {
    return JSON.stringify({ error: 'fetch_failed', detail: String(e).slice(0, 120) });
  }
}

async function runTool(call: ToolCall): Promise<string> {
  let args: Record<string, string> = {};
  try { args = JSON.parse(call.arguments || '{}'); } catch { /* 空参数 */ }
  if (call.name === 'WebSearch') return webSearch(String(args.query ?? ''));
  if (call.name === 'WebFetch') return webFetch(String(args.url ?? ''));
  return JSON.stringify({ error: 'unknown_tool' });
}

// OpenAI 兼容的 QCA 替身：系统提示 + function-calling 检索循环，
// 把回复包装成 app 消费的 QCA 事件流。密钥只在 Function 进程内使用。
// 会话历史以 DB 对话记录为准（跨 isolate 不丢上下文）；无 db 时退化为内存历史。
export function createOpenAiQca(config: LocalLlmConfig, db?: Db): QcaAdapter {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const turns = new Map<string, Turn>();
  const histories = new Map<string, { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[]>();

  async function dbHistory(sessionId: string) {
    const convId = sessionId.replace(/^local-/, '');
    const rs = rows(await db!.from('messages').select('role,kind,content,seq').eq('conversation_id', convId).order('seq', { ascending: true }).limit(40));
    const hist = rs
      .filter((m: any) => (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m: any) => ({ role: m.role as string, content: String(m.content) }));
    // 本轮用户消息已由 message 参数提供（DB 里是先落库的原文），去掉尾部重复。
    if (hist.at(-1)?.role === 'user') hist.pop();
    return hist;
  }

  async function complete(
    sessionId: string,
    message: string,
    signal: AbortSignal | undefined,
    onDelta: (text: string) => void,
    onTool: (name: string) => void,
  ): Promise<string> {
    const history = db ? await dbHistory(sessionId) : [...(histories.get(sessionId) ?? [])];
    const last = history.at(-1);
    if (last?.role !== 'user' || last.content !== message) history.push({ role: 'user', content: message });
    const messages: unknown[] = [{ role: 'system', content: buildSystemPrompt() }, ...history];
    let finalText = '';
    // 检索最多一轮：工具执行期间没有上游增量，多轮检索会把整轮预算耗光。
    let toolRounds = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS + 2; round++) {
      const useTools = toolRounds < MAX_TOOL_ROUNDS;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, stream: true, max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS, messages, ...(useTools ? { tools: TOOLS, tool_choice: 'auto' } : {}) }),
        signal,
      });
      if (!res.ok) throw new Error(`llm_http_${res.status}`);

      let content = '';
      const calls: ToolCall[] = [];
      const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
      if (!isStream) {
        const json = (await res.json()) as CompletionChunk;
        const msg = json.choices?.[0]?.message;
        content = msg?.content ?? '';
        for (const c of msg?.tool_calls ?? []) calls.push({ id: c.id, name: c.function.name, arguments: c.function.arguments });
        if (content) onDelta(content);
      } else {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
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
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) { content += delta.content; onDelta(delta.content); }
              for (const tc of delta?.tool_calls ?? []) {
                const i = tc.index ?? calls.length;
                while (calls.length <= i) calls.push({ id: '', name: '', arguments: '' });
                if (tc.id) calls[i].id = tc.id;
                if (tc.function?.name) calls[i].name += tc.function.name;
                if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }

      const valid = calls.filter((c) => c.name);
      if (!valid.length || !useTools) {
        finalText = content;
        break;
      }
      toolRounds++;
      messages.push({ role: 'assistant', content: content || null, tool_calls: valid.map((c) => ({ id: c.id || `call_${round}_${c.name}`, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
      for (const c of valid) {
        onTool(c.name);
        const result = await runTool(c);
        messages.push({ role: 'tool', tool_call_id: c.id || `call_${round}_${c.name}`, content: result });
      }
      // 工具轮已用完：明确要求直接作答，避免模型再耗一轮空转。
      if (toolRounds >= MAX_TOOL_ROUNDS) messages.push({ role: 'system', content: '检索轮已结束。现在不要再调用工具，直接基于已有信息给出最终回答或完整 JSON 产物。' });
    }

    if (finalText && !db) histories.set(sessionId, [...history, { role: 'assistant', content: finalText }].slice(-20));
    return finalText;
  }

  return {
    async ensureBinding() { return { agent: { type: 'agent', id: 'local-openai', version: 1 }, environment_id: 'local' }; },
    async createSession(_binding, _title, metadata) {
      const convId = (metadata as any)?.conversation_id;
      return { id: convId ? `local-${convId}` : `local-${crypto.randomUUID()}` };
    },
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
            const full = await complete(
              sessionId,
              message,
              opts.signal,
              (text) => controller.enqueue(encodeSSE('event_delta', { type: 'event_delta', event_id: 'local', delta: { type: 'content_delta', content: { type: 'text', text } } })),
              (name) => controller.enqueue(encodeSSE('agent.tool_use', { type: 'agent.tool_use', name })),
            );
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