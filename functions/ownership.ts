import { rows } from './db.ts';
import type { Db } from './db.ts';
import { SHARED_BLOCK_PLAN_ID } from '../shared/constants.ts';

async function deleteWhere(db: Db, table: string, col: string, val: string): Promise<number> {
  const n = rows(await db.from(table).select(col).eq(col, val)).length;
  if (n) rows(await db.from(table).delete().eq(col, val));
  return n;
}

export async function deleteVisitorData(db: Db, visitor: string): Promise<Record<string, number>> {
  const planIds = rows(await db.from('plans').select('id').eq('owner_visitor_id', visitor)).map((p) => p.id);
  const convIds = rows(await db.from('conversations').select('id').eq('owner_visitor_id', visitor)).map((c) => c.id);
  const deleted: Record<string, number> = {
    messages: 0, dispatch_intents: 0, blocks: 0, task_defs: 0, constraints: 0,
    commit_log: 0, conversations: 0, plans: 0, quotas: 0, recovery_codes: 0,
  };
  for (const cid of convIds) deleted.messages += await deleteWhere(db, 'messages', 'conversation_id', cid);
  deleted.dispatch_intents = await deleteWhere(db, 'dispatch_intents', 'visitor_id', visitor);
  for (const pid of planIds) {
    deleted.blocks += await deleteWhere(db, 'blocks', 'plan_id', pid);
    deleted.task_defs += await deleteWhere(db, 'task_defs', 'plan_id', pid);
    deleted.constraints += await deleteWhere(db, 'constraints', 'plan_id', pid);
  }
  // 公共日历块（plan_id 为空）不属于任何计划，必须按 owner 单独清理；
  // 否则「删除全部数据」后日历上仍留着上班等忙时块。
  const publicBlocks = rows(await db.from('blocks').select('id').eq('plan_id', SHARED_BLOCK_PLAN_ID).eq('owner_visitor_id', visitor)).length;
  if (publicBlocks) rows(await db.from('blocks').delete().eq('plan_id', SHARED_BLOCK_PLAN_ID).eq('owner_visitor_id', visitor));
  deleted.blocks += publicBlocks;
  deleted.commit_log = await deleteWhere(db, 'commit_log', 'visitor_id', visitor);
  deleted.conversations = await deleteWhere(db, 'conversations', 'owner_visitor_id', visitor);
  deleted.plans = await deleteWhere(db, 'plans', 'owner_visitor_id', visitor);
  deleted.profiles = await deleteWhere(db, 'profiles', 'visitor_id', visitor);
  deleted.quotas = await deleteWhere(db, 'quotas', 'visitor_id', visitor);
  deleted.recovery_codes = await deleteWhere(db, 'recovery_codes', 'visitor_id', visitor);
  return deleted;
}

export async function transferOwnership(db: Db, from: string, to: string): Promise<{ plans_count: number; conversations_count: number }> {
  const plans = rows(await db.from('plans').update({ owner_visitor_id: to }).eq('owner_visitor_id', from).select('id'));
  const conversations = rows(await db.from('conversations').update({ owner_visitor_id: to }).eq('owner_visitor_id', from).select('id'));
  // 公共日历块不挂在计划下，按 owner 直接跟随；否则认领后共享日历会留在旧身份上。
  rows(await db.from('blocks').update({ owner_visitor_id: to }).eq('owner_visitor_id', from).eq('plan_id', SHARED_BLOCK_PLAN_ID).select('id'));
  rows(await db.from('dispatch_intents').update({ visitor_id: to }).eq('visitor_id', from).select('request_id'));
  rows(await db.from('commit_log').update({ visitor_id: to }).eq('visitor_id', from).select('preview_id'));
  // quotas 有 (visitor_id, day) 唯一键：续跑时限流可能已给 to 重建今日行，
  // 直接 UPDATE 会撞键。按 day 先删 to 的同日行再转移 from 的行，幂等无冲突。
  const quotaDays = rows(await db.from('quotas').select('day').eq('visitor_id', from)).map((q) => q.day);
  for (const day of quotaDays) {
    rows(await db.from('quotas').delete().eq('visitor_id', to).eq('day', day));
    rows(await db.from('quotas').update({ visitor_id: to }).eq('visitor_id', from).eq('day', day).select('day'));
  }
  return { plans_count: plans.length, conversations_count: conversations.length };
}