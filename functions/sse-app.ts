import { rows } from './db.ts';
import type { Db } from './db.ts';
import type { Conversation } from './qca/sessions.ts';
export function appFrame(seq: number, event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
export async function insertMessage(db: Db, conv: Conversation, msg: { seq: number; role: string; kind: string; content?: string; payload?: unknown }): Promise<void> {
  rows(await db.from('messages').insert({ conversation_id: conv.id, seq: msg.seq, role: msg.role, kind: msg.kind, content: msg.content ?? '', payload: msg.payload ?? null }).select('id'));
}
export async function appendAssistant(db: Db, conv: Conversation, seq: number, text: string): Promise<void> {
  const existing = rows(await db.from('messages').select('id,content,kind,role').eq('conversation_id', conv.id).eq('seq', seq).limit(1))[0];
  // 只允许追加到助手文本行；若该 seq 已是 status/error 等系统行（失败回合的孤儿），不得把正文拼上去造成污染。
  if (existing) {
    if (existing.kind === 'text' && existing.role === 'assistant') rows(await db.from('messages').update({ content: existing.content + text }).eq('id', existing.id).select('id'));
    return;
  }
  rows(await db.from('messages').insert({ conversation_id: conv.id, seq, role: 'assistant', kind: 'text', content: text, payload: null }).select('id'));
}
export async function advanceCursor(db: Db, conv: Conversation, seq: number, eventId?: string | null): Promise<void> {
  rows(await db.from('conversations').update({ last_seq: seq, last_event_id: eventId ?? conv.last_event_id, updated_at: new Date().toISOString() })
    .eq('id', conv.id).eq('owner_visitor_id', conv.owner_visitor_id).select('id'));
}
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}