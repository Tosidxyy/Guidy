import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { incrementChatTurn, assertNoPendingDispatch, todayStr } from '../quotas.ts';
import { beginDispatch, markDispatch } from '../qca/dispatch.ts';
import { ensureConversation, getOwnedConversation, ensureQcaSession } from '../qca/sessions.ts';
import { createProjector } from '../qca/project.ts';
import { parseModelText } from '../artifacts.ts';
import { buildUserMessage } from '../prompt.ts';
import { appFrame, insertMessage, appendAssistant, advanceCursor, sha256Hex } from '../sse-app.ts';
import { readSSE } from '../qca/sse.mjs';
import { LIMITS } from '../../shared/constants.ts';
import type { Deps, RouteCtx, AppEvent } from '../types.ts';

export const interruptRegistry = new Map<string, AbortController>();
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' };

async function loadPlanState(db: Deps['db'], visitor: string, planId: string | null) {
  if (!planId) return null;
  const plan = rows(await db.from('plans').select('*').eq('id', planId).eq('owner_visitor_id', visitor).limit(1))[0];
  if (!plan) return null;
  const task_defs = rows(await db.from('task_defs').select('*').eq('plan_id', planId));
  const constraints = rows(await db.from('constraints').select('*').eq('plan_id', planId));
  const blocks = rows(await db.from('blocks').select('*').eq('plan_id', planId));
  return { plan, task_defs, constraints, blocks };
}

export async function chatSend(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 8192);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > LIMITS.messageChars) fail('validation_failed', 422);
  const requestId = typeof body.request_id === 'string' && body.request_id ? body.request_id : crypto.randomUUID();
  const conv = await ensureConversation(deps.db, visitor, body.conversation_id ?? null, text.slice(0, 30), body.plan_id ?? null);
  const day = todayStr(deps.now?.() ?? new Date());
  await incrementChatTurn(deps.db, visitor, day);
  await assertNoPendingDispatch(deps.db, visitor);
  const fingerprint = await sha256Hex(`${visitor}:${text}`);
  const { replay, intent } = await beginDispatch(deps.db, { request_id: requestId, visitor_id: visitor, conversation_id: conv.id, payload_fingerprint: fingerprint });
  const planState = await loadPlanState(deps.db, visitor, body.plan_id ?? null);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = conv.last_seq;
      const nextSeq = () => ++seq;
      const emit = (e: AppEvent) => controller.enqueue(appFrame(e.data.seq, e.event, e.data));
      const abort = new AbortController();
      interruptRegistry.set(conv.id, abort);
      let phase = 'start';
      try {
        const userSeq = nextSeq();
        emit({ event: 'accepted', data: { request_id: requestId, conversation_id: conv.id, seq: userSeq } });
        phase = 'insert_user_message';
        await insertMessage(deps.db, conv, { seq: userSeq, role: 'user', kind: 'text', content: text });
        phase = 'advance_cursor';
        await advanceCursor(deps.db, conv, seq);
        if (replay) {
          for (const e of (intent.result ?? []) as AppEvent[]) emit({ ...e, data: { ...e.data, seq: nextSeq() } } as AppEvent);
          emit({ event: 'done', data: { seq: nextSeq() } });
          return;
        }
        phase = 'ensure_qca_session';
        const { sessionId } = await ensureQcaSession(deps, conv);
        const collected: AppEvent[] = [];
        const assistantSeq = nextSeq();
        let finalText = '';
        let lastEventId: string | null = conv.last_event_id;
        let terminalState: 'completed' | 'failed' | 'interrupted' = 'failed';
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await deps.db.from('messages').delete().eq('conversation_id', conv.id).eq('seq', assistantSeq);
          const projector = createProjector(nextSeq, assistantSeq);
          phase = 'open_stream';
          const upstream = await deps.qca.openStream(sessionId, { lastEventId: conv.last_event_id ?? undefined, signal: abort.signal });
          try {
            phase = 'send_events';
            await deps.qca.sendEvents(sessionId, buildUserMessage({ message: text, plan: planState, history: [] }), `${requestId}:${attempt}`);
            phase = 'read_stream';
            for await (const frame of readSSE(upstream.body, { signal: abort.signal })) {
              const ev = JSON.parse(frame.data);
              if (frame.id) lastEventId = frame.id;
              for (const p of projector.push(ev)) {
                emit(p); collected.push(p);
                if (p.event === 'delta') await appendAssistant(deps.db, conv, p.data.seq, p.data.text);
                if (p.event === 'status') { terminalState = p.data.state === 'completed' ? 'completed' : 'failed'; await insertMessage(deps.db, conv, { seq: p.data.seq, role: 'system', kind: 'status', content: p.data.state }); }
                if (p.event === 'error') { terminalState = 'failed'; await insertMessage(deps.db, conv, { seq: p.data.seq, role: 'system', kind: 'error', content: p.data.code }); }
              }
            }
          } finally { upstream.close(); }
          finalText = projector.text();
          if (abort.signal.aborted) { terminalState = 'interrupted'; break; }
          if (!projector.isTerminal()) { terminalState = 'failed'; break; }
          const expectsArtifact = /```json|^\s*\{/.test(finalText);
          const parsed = parseModelText(finalText);
          if (parsed) {
            const art: AppEvent = { event: 'artifact', data: { seq: nextSeq(), kind: parsed.kind, payload: parsed.value } };
            emit(art); collected.push(art);
            await insertMessage(deps.db, conv, { seq: art.data.seq, role: 'assistant', kind: parsed.kind, content: finalText, payload: parsed.value });
            break;
          }
          if (expectsArtifact && attempt < 2) continue;
          if (expectsArtifact) {
            const err: AppEvent = { event: 'error', data: { seq: nextSeq(), code: 'artifact_invalid', message: 'AI 返回的结构化结果无效，请重试', diagnostic_id: crypto.randomUUID() } };
            emit(err); collected.push(err); terminalState = 'failed';
            await insertMessage(deps.db, conv, { seq: err.data.seq, role: 'system', kind: 'error', content: 'artifact_invalid' });
          }
          break;
        }
        phase = 'advance_cursor_final';
        await advanceCursor(deps.db, conv, seq, lastEventId);
        const status: AppEvent = { event: 'status', data: { seq: nextSeq(), state: terminalState } };
        emit(status); collected.push(status);
        emit({ event: 'done', data: { seq: nextSeq() } });
        phase = 'mark_dispatch';
        await markDispatch(deps.db, requestId, { status: terminalState === 'completed' ? 'done' : terminalState, session_id: sessionId, result: collected });
        phase = 'update_conversation';
        await deps.db.from('conversations').update({ status: terminalState === 'completed' ? 'active' : terminalState }).eq('id', conv.id);
      } catch (e) {
        console.error('chat_send_failed', JSON.stringify({ code: (e as any)?.code, status: (e as any)?.status, outcome: (e as any)?.outcome, message: String((e as any)?.message ?? e).slice(0, 300) }));
        const err: AppEvent = { event: 'error', data: { seq: nextSeq(), code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID(), upstream_code: typeof (e as any)?.code === 'string' ? (e as any).code : undefined, upstream_phase: phase, upstream_message: String((e as any)?.message ?? e).slice(0, 200) } };
        controller.enqueue(appFrame(err.data.seq, err.event, err.data));
        controller.enqueue(appFrame(nextSeq(), 'done', { seq }));
        await markDispatch(deps.db, requestId, { status: 'failed' }).catch(() => {});
      } finally {
        interruptRegistry.delete(conv.id);
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 202, headers: SSE_HEADERS });
}

export async function chatHistory(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const id = new URL(ctx.request.url).searchParams.get('conversation_id') ?? '';
  const conv = await getOwnedConversation(deps.db, visitor, id);
  const messages = rows(await deps.db.from('messages').select('*').eq('conversation_id', id).order('seq', { ascending: true }).limit(200));
  return Response.json({ conversation: conv, messages }, { headers: { 'cache-control': 'no-store' } });
}

export async function chatEvents(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const url = new URL(ctx.request.url);
  const id = url.searchParams.get('conversation_id') ?? '';
  const [cursorSeqStr, offsetStr] = (url.searchParams.get('cursor') ?? '0:0').split(':');
  const cursorSeq = Number(cursorSeqStr) || 0;
  const offset = Number(offsetStr) || 0;
  const conv = await getOwnedConversation(deps.db, visitor, id);
  const messages = rows(await deps.db.from('messages').select('*').eq('conversation_id', id).order('seq', { ascending: true }).limit(500));
  const pending = rows(await deps.db.from('dispatch_intents').select('request_id').eq('conversation_id', id).eq('status', 'pending').limit(1));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = conv.last_seq;
      const nextSeq = () => ++seq;
      try {
        for (const m of messages) {
          if (m.seq < cursorSeq) continue;
          if (m.kind === 'text' && m.role === 'assistant') {
            const t = m.seq === cursorSeq ? String(m.content).slice(offset) : String(m.content);
            controller.enqueue(appFrame(m.seq, 'delta', { seq: m.seq, text: t }));
          } else if (m.kind === 'constraint_set' || m.kind === 'patch') {
            controller.enqueue(appFrame(m.seq, 'artifact', { seq: m.seq, kind: m.kind, payload: m.payload }));
          } else if (m.kind === 'status') {
            controller.enqueue(appFrame(m.seq, 'status', { seq: m.seq, state: m.content }));
          } else if (m.kind === 'error') {
            controller.enqueue(appFrame(m.seq, 'error', { seq: m.seq, code: m.content, message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() }));
          }
        }
        if (pending.length) {
          const { sessionId } = await ensureQcaSession(deps, conv);
          const abort = new AbortController();
          interruptRegistry.set(conv.id, abort);
          const projector = createProjector(nextSeq, nextSeq());
          const upstream = await deps.qca.openStream(sessionId, { lastEventId: conv.last_event_id ?? undefined, signal: abort.signal });
          try {
            for await (const frame of readSSE(upstream.body, { signal: abort.signal })) {
              for (const p of projector.push(JSON.parse(frame.data))) controller.enqueue(appFrame(p.data.seq, p.event, p.data));
            }
          } finally { upstream.close(); interruptRegistry.delete(conv.id); }
        }
        controller.enqueue(appFrame(nextSeq(), 'done', { seq }));
      } catch (e) {
        console.error('chat_events_failed', JSON.stringify({ code: (e as any)?.code, status: (e as any)?.status, outcome: (e as any)?.outcome, message: String((e as any)?.message ?? e).slice(0, 300) }));
        controller.enqueue(appFrame(nextSeq(), 'error', { seq, code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID(), upstream_code: typeof (e as any)?.code === 'string' ? (e as any).code : undefined }));
        controller.enqueue(appFrame(nextSeq(), 'done', { seq }));
      } finally { controller.close(); }
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

export async function chatInterrupt(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 2048);
  const conv = await getOwnedConversation(deps.db, visitor, String(body.conversation_id ?? ''));
  interruptRegistry.get(conv.id)?.abort();
  await deps.db.from('conversations').update({ status: 'interrupted' }).eq('id', conv.id).eq('owner_visitor_id', visitor);
  const pending = rows(await deps.db.from('dispatch_intents').select('request_id').eq('conversation_id', conv.id).eq('status', 'pending').limit(1));
  if (pending[0]) await markDispatch(deps.db, pending[0].request_id, { status: 'interrupted' });
  return Response.json({ ok: true, status: 'interrupted' });
}