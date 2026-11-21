import type { QcaAdapter, QcaBinding } from '../types.ts';
import { readSSE } from './sse.mjs';

export interface QcaProvider {
  name: string;
  adapter: QcaAdapter;
}

// 配额/鉴权/限流/上游不可用/网络失败/首包超时才切换；模型产物 invalid 等业务错误不切换（换供应商也一样错）。
export function isFailoverError(e: unknown): boolean {
  const err = e as { code?: string; status?: number; message?: string; name?: string };
  const code = String(err?.code ?? '');
  const status = Number(err?.status ?? 0);
  const msg = String(err?.message ?? '');
  return ['quota_exceeded', 'insufficient_quota', 'rate_limited', 'unauthorized', 'forbidden', 'service_unavailable', 'timeout'].includes(code)
    || [401, 403, 408, 429].includes(status)
    || (status >= 500 && status < 600)
    || /llm_http_(401|403|408|429|5\d\d)/.test(msg)
    || /quota|credit|balance|rate.?limit|unauthorized|forbidden|insufficient/i.test(msg)
    || err?.name === 'TimeoutError'
    || /timeout|timed out|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|network/i.test(`${msg} ${code}`);
}

interface SessionRef { idx: number; realId: string }

/**
 * 按轮 failover 的 QCA 包装：首选 QCA，配额/鉴权类错误自动落到后续 OpenAI 兼容供应商。
 * 会话 id 用包装 id，内部映射到真实供应商会话；冷启动丢失映射时按当前供应商重建。
 */
export function createResilientQca(providers: QcaProvider[]): QcaAdapter {
  let idx = 0;
  let scope = 'resilient';
  const sessions = new Map<string, SessionRef>();
  const bindings = new Map<number, QcaBinding>();
  const turns = new Map<string, { text?: string; key?: string; waiter?: (v: { text: string; key?: string }) => void }>();

  async function bindingAt(i: number): Promise<QcaBinding> {
    let b = bindings.get(i);
    if (!b) {
      b = await providers[i].adapter.ensureBinding(scope);
      bindings.set(i, b);
    }
    return b;
  }
  async function sessionAt(i: number, title: string, metadata: Record<string, unknown>): Promise<string> {
    const b = await bindingAt(i);
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
    async ensureBinding(scopeArg) {
      scope = scopeArg;
      let lastErr: unknown;
      for (let i = idx; i < providers.length; i++) {
        try {
          const b = await bindingAt(i);
          if (i > idx) console.info('provider_switch', providers[idx].name, '->', providers[i].name);
          idx = i;
          return b;
        } catch (e) {
          console.error('provider_failed', providers[i].name, (e as any)?.status ?? (e as any)?.code ?? '', String((e as any)?.message ?? e).slice(0, 200));
          lastErr = e;
          if (!isFailoverError(e)) throw e;
        }
      }
      throw lastErr;
    },
    async createSession(_binding, title, metadata) {
      let lastErr: unknown;
      for (let i = idx; i < providers.length; i++) {
        try {
          const realId = await sessionAt(i, title, metadata ?? {});
          idx = i;
          // 映射持久化进会话 id（JSON）：edge 多 isolate 不共享内存，冷启动靠它复用真实会话，避免重建撞 409。
          const id = JSON.stringify({ i, r: realId });
          sessions.set(id, { idx: i, realId });
          return { id };
        } catch (e) {
          console.error('provider_failed', providers[i].name, (e as any)?.status ?? (e as any)?.code ?? '', String((e as any)?.message ?? e).slice(0, 200));
          lastErr = e;
          if (!isFailoverError(e)) throw e;
        }
      }
      throw lastErr;
    },
    async sendEvents(wrapperId, text, idempotencyKey) {
      // 只把本轮文本+幂等键交给 openStream 的泵；真正发往供应商在泵里按 failover 顺序执行，避免双发。
      const t = turns.get(wrapperId) ?? {};
      if (t.waiter) {
        const waiter = t.waiter;
        turns.delete(wrapperId);
        waiter({ text, key: idempotencyKey });
      } else {
        turns.set(wrapperId, { text, key: idempotencyKey });
      }
      return { eventIds: ['resilient'] };
    },
    async openStream(wrapperId, opts) {
      const pending = new Promise<{ text: string; key?: string }>((resolve) => {
        const t = turns.get(wrapperId) ?? {};
        if (t.text !== undefined) {
          turns.delete(wrapperId);
          resolve({ text: t.text, key: t.key });
          return;
        }
        t.waiter = resolve;
        turns.set(wrapperId, t);
      });
      // 关闭/取消必须真正中止内部读取并释放上游；关闭后的写入一律丢弃（否则日志刷 ERR_INVALID_STATE 并误判供应商失败）。
      let closed = false;
      const abort = new AbortController();
      const signal = abort.signal;
      const upstreamSignals: AbortController[] = [];
      let upstreamRef: { close(): void } | null = null;
      const stop = () => {
        if (closed) return;
        closed = true;
        abort.abort();
        for (const s of upstreamSignals) s.abort();
        try { upstreamRef?.close(); } catch { /* 已关闭 */ }
      };
      const combinedSignal = (opts.signal ? AbortSignal.any([opts.signal, signal]) : signal) as AbortSignal;
      const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
        if (closed) return false;
        try { controller.enqueue(chunk); return true; } catch { closed = true; return false; }
      };
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const { text, key } = await pending;
          if (closed) { try { controller.close(); } catch { /* closed */ } return; }
          const ref = refOf(wrapperId);
          const startIdx = ref.idx;
          let lastErr: unknown;
          for (let i = ref.idx; i < providers.length; i++) {
            if (closed || combinedSignal.aborted) break;
            let realId = i === ref.idx ? ref.realId : '';
            let failed = false;
            // 落到备用供应商时给用户可见提示（投影为 progress/ModelSwitch）。
            if (i > startIdx) {
              console.info('provider_switch', providers[startIdx].name, '->', providers[i].name);
              safeEnqueue(controller, new TextEncoder().encode(`data: ${JSON.stringify({ type: 'provider.switch', name: providers[i].name })}\n\n`));
            }
            try {
              if (!realId) realId = await sessionAt(i, 'resume', {});
              // 先 send 再 open：带续读游标时 QCA 只推送开流之后已存在的新回合事件，先开后发会静默挂起。
              // 幂等键必须每回合唯一且符合平台字符集（会话 id 是 JSON，不能直接进键）。
              const turnKey = `${key ?? 'resilient'}-p${i}`.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 200);
              await providers[i].adapter.sendEvents(realId, text, turnKey);
              const upstream = await providers[i].adapter.openStream(realId, { ...opts, signal: combinedSignal });
              upstreamRef = upstream;
              const decoder = new TextDecoder();
              let failedMsg: string | null = null;
              let forwardedContent = false;
              for await (const frame of readSSE(upstream.body, { signal: combinedSignal })) {
                if (closed) break;
                let payload: any = null;
                try { payload = JSON.parse(frame.data); } catch { /* 非 JSON 帧 */ }
                // 失败供应商的错误帧扣住不发：能切换时用户不该看到它。
                if (payload?.type === 'session.error' || payload?.status === 'failed') {
                  failed = true;
                  failedMsg = String(payload?.message ?? 'upstream_error');
                  break;
                }
                const raw = new TextEncoder().encode(`id: ${frame.id ?? ''}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`);
                if (!safeEnqueue(controller, raw)) break;
                if (payload?.type === 'event_delta' || payload?.type === 'agent.message') forwardedContent = true;
                const chunk = decoder.decode(raw);
                // QCA 持久流不 EOF：遇到终态即结束本轮，否则流不释放、下一轮 send 撞 409。
                if (/"type"\s*:\s*"session\.(status_idle|completed)"/.test(chunk) || /"type"\s*:\s*"session\.status"[^}]*"status"\s*:\s*"idle"/.test(chunk)) break;
              }
              upstream.close();
              upstreamRef = null;
              ref.idx = i;
              ref.realId = realId;
              idx = i;
              if (closed || combinedSignal.aborted) return;
              if (!failed) {
                try { controller.close(); } catch { /* closed */ }
                return;
              }
              const streamErr = new Error(failedMsg ?? `provider_${providers[i].name}_stream_failed`);
              console.error('provider_failed', providers[i].name, '', String(streamErr.message).slice(0, 200));
              lastErr = streamErr;
              // 已输出正文再切换会重复生成：只能把扣住的错误帧原样下发。
              if (forwardedContent) {
                if (safeEnqueue(controller, new TextEncoder().encode(`data: ${JSON.stringify({ type: 'session.error', status: 'failed', message: streamErr.message })}\n\n`))) {
                  try { controller.close(); } catch { /* closed */ }
                }
                return;
              }
            } catch (e) {
              // 主动关闭/取消不算供应商失败：不记 provider_failed、不切换。
              if (closed || combinedSignal.aborted) return;
              console.error('provider_failed', providers[i].name, (e as any)?.code ?? '', String((e as any)?.message ?? e).slice(0, 200));
              lastErr = e;
              if (!isFailoverError(e)) break;
            }
            if (closed || combinedSignal.aborted) break;
          }
          if (closed || combinedSignal.aborted) return;
          const msg = String((lastErr as Error)?.message ?? 'upstream_error');
          if (safeEnqueue(controller, new TextEncoder().encode(`data: ${JSON.stringify({ type: 'session.error', status: 'failed', message: msg })}

`))) {
            try { controller.close(); } catch { /* closed */ }
          }
        },
        cancel() { stop(); },
      });
      return { body, close: stop };
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