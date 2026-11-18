import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { fail } from '../errors.ts';
import type { Deps } from '../types.ts';
export interface Conversation { id: string; owner_visitor_id: string; title: string; qca_session_id: string | null; last_seq: number; last_event_id: string | null; status: string; plan_id: string | null }
export async function listConversations(db: Db, visitor: string): Promise<Conversation[]> {
  const items = rows(await db.from('conversations').select('*').eq('owner_visitor_id', visitor).order('updated_at', { ascending: false }).limit(50)) as Conversation[];
  // 归档 = 计划已删除的对话：数据保留，但不再参与恢复与列表。
  return items.filter((c) => c.status !== 'archived');
}
export async function getOwnedConversation(db: Db, visitor: string, id: string): Promise<Conversation> {
  const c = rows(await db.from('conversations').select('*').eq('id', id).limit(1))[0];
  if (!c) fail('not_found', 404);
  if (c.owner_visitor_id !== visitor) fail('forbidden', 403);
  return c;
}
export async function ensureConversation(db: Db, visitor: string, id?: string | null, title?: string, planId?: string | null): Promise<Conversation> {
  if (id) return getOwnedConversation(db, visitor, id);
  return rows(await db.from('conversations').insert({ owner_visitor_id: visitor, title: title ?? '新对话', plan_id: planId ?? null, qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' }).select('*'))[0];
}
export async function ensureQcaSession(deps: Deps, conv: Conversation): Promise<{ sessionId: string }> {
  if (conv.qca_session_id) return { sessionId: conv.qca_session_id };
  const binding = await deps.qca.ensureBinding(deps.config.appScope);
  const session = await deps.qca.createSession(binding, conv.title, { visitor_id: conv.owner_visitor_id, conversation_id: conv.id });
  rows(await deps.db.from('conversations').update({ qca_session_id: session.id }).eq('id', conv.id).eq('owner_visitor_id', conv.owner_visitor_id).select('id'));
  return { sessionId: session.id };
}