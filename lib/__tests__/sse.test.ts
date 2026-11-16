import { describe, it, expect, beforeEach } from 'vitest';
import { createChatStream } from '@/lib/sse';
import { useChatStore } from '@/store/useChatStore';

const sse = (frames: { id: number; event: string; data: unknown }[]) =>
  frames.map((f) => `id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');

describe('createChatStream', () => {
  beforeEach(() => useChatStore.getState().reset());

  it('reads past a terminal status until done so a trailing artifact is applied', async () => {
    const body = sse([
      { id: 1, event: 'accepted', data: { request_id: 'r', conversation_id: 'c', seq: 1 } },
      { id: 2, event: 'delta', data: { seq: 2, text: 'hello' } },
      { id: 3, event: 'status', data: { seq: 3, state: 'completed' } },
      { id: 4, event: 'artifact', data: { seq: 4, kind: 'constraint_set', payload: { type: 'constraint_set', plan_title: 't', horizon_days: 7, task_defs: [], constraints: [], clarifications_needed: [] } } },
      { id: 5, event: 'done', data: { seq: 5 } },
    ]);
    const stream = createChatStream();
    await stream.read(async () => new Response(body, { status: 202, headers: { 'content-type': 'text/event-stream' } }));
    const st = useChatStore.getState();
    expect(st.artifact?.type).toBe('constraint_set');
    expect(st.streaming).toBe(false);
  });
});