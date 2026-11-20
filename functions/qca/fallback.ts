import type { QcaAdapter, QcaBinding } from '../types.ts';
import { readSSE } from './sse.mjs';

export interface QcaProvider {
  name: string;
  adapter: QcaAdapter;
}

// 配额/鉴权/限流/上游不可用才切换；模型产物 invalid 等业务错误不切换（换供应商也一样错）。
export function isFailoverError(e: unknown): boolean {
  const err = e as { code?: string; status?: number; message?: string };
  const code = String(err?.code ?? '');
  const status = Number(err?.status ?? 0);
  const msg = String(err?.message ?? '');
  return ['quota_exceeded', 'insufficient_quota', 'rate_limited', 'unauthorized', 'forbidden', 'service_unavailable'].includes(code)
    || [401, 403, 429, 500, 502, 503].includes(status)
    || /llm_http_(401|403|429|5\d\d)/.test(msg)
    || /quota|credit|balance|rate.?limit|unauthorized|forbidden|insufficient/i.test(msg);
}

interface SessionRef { idx: number; realId: string }

/**
 * 按轮 failover 的 QCA 包装：首选 QCA，配额/鉴权类错误自动落到后续 OpenAI 兼容供应商。
 * 会话 id 用包装 id，内部映射到真实供应商会话；冷启动丢失映射时按当前供应商重建。
 */
export function createResilientQca(providers: QcaProvider[]): QcaAdapter {
  let idx = 0;
  const sessions = new Map<string, SessionRef>();
  const bindings = new Map<number, QcaBinding>();
  const turns = new Map<string, { text?: string; waiter?: (text: string) => void }>();

  async function bindingAt(i: number, scope: string): Promise<QcaBinding> {
    let b = bindings.get(i);
    if (!b) {
      b = await providers[i].adapter.ensureBinding(scope);
      bindings.set(i, b);
    }
    return b;
  }
  async function sessionAt(i: number, title: string, metadata: Record<string, unknown>): Promise<string> {
    const b = await bindingAt(i, 'resilient');
    const s = await providers[i].adapter.createSession(b, title, metadata);
    return s.id;
  }
  function refOf(wrapperId: string): SessionRef {
    let ref = sessions.get(wrapperId);
    if (!ref) {
      if (wrapperId.startsWith('{')) {
        try {
          const p = JSON.parse(wrapperId) as { i?: number; r?: string };
          if (typeof p.r === 'string' && p.r) {
            ref = { idx: typeof p.i === 'number' ? p.i : idx, realId: p.r };
            sessions.set(wrapperId, ref);
            return ref;
          }
        } catch { /* fall through */ }
      }
      ref = { idx, realId: '' };
      sessions.set(wrapperId, ref);
    }
    return ref;
  }

  return {
    async ensureBinding(scope) {
      let lastErr: unknown;
      for (let i = idx; i < providers.length; i++) {
        try {
          const b = await bindingAt(i, scope);
          idx = i;
          return b;
        } catch (e) {
          lastErr = e;
          if (!isFailoverError(e)) throw e;
        }
      }
      throw lastErr;
    },
    async createSession(_binding, title, metadata) {
      const realId = await sessionAt(idx, title, metadata ?? {});
      // 映射持久化进会话 id（JSON）：edge 多 isolate 不共享内存，冷启动靠它复用真实会话，避免重建撞 409。
      const id = JSON.stringify({ i: idx, r: realId });
      sessions.set(id, { idx, realId });
      return { id };
    },
    async sendEvents(wrapperId, text) {
      // 只把本轮文本交给 openStream 的泵；真正发往供应商在泵里按 failover 顺序执行，避免双发。
      const t = turns.get(wrapperId) ?? {};
      if (t.waiter) {
        const waiter = t.waiter;
        turns.delete(wrapperId);
        waiter(text);
      } else {
        turns.set(wrapperId, { text });
      }
      return { eventIds: ['resilient'] };
    },
    async openStream(wrapperId, opts) {
      const pending = new Promise<string>((resolve) => {
        const t = turns.get(wrapperId) ?? {};
        if (t.text !== undefined) {
          turns.delete(wrapperId);
          resolve(t.text);
          return;
        }
        t.waiter = resolve;
        turns.set(wrapperId, t);
      });
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const text = await pending;
          const ref = refOf(wrapperId);
          let lastErr: unknown;
          for (let i = ref.idx; i < providers.length; i++) {
            let realId = i === ref.idx ? ref.realId : '';
            let failed = false;
            try {
              if (!realId) realId = await sessionAt(i, 'resume', {});
              // 先 send 再 open：带续读游标时 QCA 只推送开流之后已存在的新回合事件，先开后发会静默挂起。
              await providers[i].adapter.sendEvents(realId, text, `resilient-${wrapperId}-${i}`);
              const upstream = await providers[i].adapter.openStream(realId, opts);
              const decoder = new TextDecoder();
              for await (const frame of readSSE(upstream.body, { signal: opts.signal })) {
                const raw = new TextEncoder().encode(`id: ${frame.id ?? ''}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`);
                controller.enqueue(raw);
                const chunk = decoder.decode(raw);
                if (chunk.includes('session.error') || /"status"\s*:\s*"failed"/.test(chunk)) failed = true;
                // QCA 持久流不 EOF：遇到终态即结束本轮，否则流不释放、下一轮 send 撞 409。
                if (/"type"\s*:\s*"session\.(status_idle|completed)"/.test(chunk) || /"type"\s*:\s*"session\.status"[^}]*"status"\s*:\s*"idle"/.test(chunk)) break;
              }
              upstream.close();
              ref.idx = i;
              ref.realId = realId;
              idx = i;
              if (!failed) {
                controller.close();
                return;
              }
              lastErr = new Error(`provider_${providers[i].name}_stream_failed`);
            } catch (e) {
              console.error('provider_failed', providers[i].name, (e as any)?.code ?? '', String((e as any)?.message ?? e).slice(0, 200));
              lastErr = e;
              if (!isFailoverError(e)) break;
            }
            if (opts.signal?.aborted) break;
          }
          const msg = String((lastErr as Error)?.message ?? 'upstream_error');
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'session.error', status: 'failed', message: msg })}\n\n`));
          controller.close();
        },
      });
      return { body, close() {} };
    },
    async listEvents(wrapperId, opts) {
      const ref = refOf(wrapperId);
      const order = ref ? [ref.idx, ...providers.map((_, i) => i).filter((i) => i !== ref.idx)] : providers.map((_, i) => i);
      let lastErr: unknown;
      for (const i of order) {
        try {
          const realId = ref && i === ref.idx ? ref.realId : '';
          if (!realId) continue;
          return await providers[i].adapter.listEvents(realId, opts);
        } catch (e) {
          lastErr = e;
        }
      }
      if (lastErr) throw lastErr;
      return { data: [], has_more: false };
    },
  };
}