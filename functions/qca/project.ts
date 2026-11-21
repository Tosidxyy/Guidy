import type { AppEvent } from '../types.ts';
export function createProjector(seq: () => number, deltaSeq: number) {
  const drafts = new Map<string, string>();
  let streamed = false;
  let terminal = false;
  let failed = false;
  let sawThinking = false;
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
      } else if (type === 'agent.tool_use') {
        const name: string = ev.name ?? '';
        if (name === 'WebSearch' || name === 'WebFetch' || name === 'Weather') {
          out.push({ event: 'progress', data: { seq: deltaSeq, tool: name as 'WebSearch' | 'WebFetch' | 'Weather' } });
        }
      } else if (type === 'agent.thinking') {
        sawThinking = true;
        out.push({ event: 'progress', data: { seq: deltaSeq, tool: 'Thinking' } });
      } else if (type === 'provider.switch') {
        out.push({ event: 'progress', data: { seq: deltaSeq, tool: 'ModelSwitch' } });
      } else if (type.startsWith('session')) {
        // QCA 把生命周期状态编码在事件 type 名中（session.status_idle 等），无嵌套 status 字段。
        const state: string = ev.status ?? ev.state ?? '';
        const failedNow = type === 'session.error' || state === 'failed' || state === 'error';
        const idleNow = type === 'session.status_idle' || type === 'session.completed' || state === 'idle' || state === 'completed';
        const endedNow = type === 'session.status_terminated' || type === 'session.deleted';
        const requiresAction = ev.stop_reason?.type === 'requires_action';
        if (failedNow) {
          terminal = true; failed = true;
          out.push({ event: 'error', data: { seq: seq(), code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() } });
        } else if (requiresAction) {
          terminal = true; failed = true;
          out.push({ event: 'error', data: { seq: seq(), code: 'tool_confirmation_unsupported', message: 'AI 需要工具确认，暂不支持', diagnostic_id: crypto.randomUUID() } });
        } else if (idleNow || endedNow) {
          terminal = true;
          out.push({ event: 'status', data: { seq: seq(), state: failed ? 'failed' : 'completed' } });
        }
      }
      return out;
    },
    text: fullText,
    sawThinking: () => sawThinking,
    isTerminal: () => terminal,
  };
}