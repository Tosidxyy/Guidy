import type { AppEvent } from '../types.ts';
export function createProjector(seq: () => number, deltaSeq: number) {
  const drafts = new Map<string, string>();
  let streamed = false;
  let terminal = false;
  let failed = false;
  const fullText = () => [...drafts.values()].join('');
  return {
    push(ev: any): AppEvent[] {
      const out: AppEvent[] = [];
      const type: string = ev?.type ?? '';
      if (type === 'event_delta' && ev.delta?.type === 'content_delta') {
        const t: string = ev.delta.content?.text ?? '';
        const id: string = ev.event_id ?? '0';
        if (t) {
          drafts.set(id, (drafts.get(id) ?? '') + t);
          streamed = true;
          out.push({ event: 'delta', data: { seq: deltaSeq, text: t } });
        }
      } else if (type === 'agent.message') {
        const t: string = (ev.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
        const id: string = ev.id ?? ev.event_id ?? '0';
        drafts.set(id, t);
        if (!streamed && t) out.push({ event: 'delta', data: { seq: deltaSeq, text: t } });
      } else if (type.startsWith('session')) {
        const state: string = ev.status ?? ev.state ?? '';
        if (type === 'session.error' || state === 'failed' || state === 'error') {
          terminal = true; failed = true;
          out.push({ event: 'error', data: { seq: seq(), code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() } });
        } else if (state === 'idle' || state === 'completed' || type === 'session.completed') {
          terminal = true;
          out.push({ event: 'status', data: { seq: seq(), state: failed ? 'failed' : 'completed' } });
        }
      }
      return out;
    },
    text: fullText,
    isTerminal: () => terminal,
  };
}