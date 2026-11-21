import { getAll, getOne, putOne, deleteOne, clearAll, planStorageTransaction } from './db';
import type { Block, Constraint, PlanState, TaskDef } from '@/shared/types';
import type { Profile } from '@/shared/profile';

export interface PlanRecord {
  id: string;
  title: string;
  horizon_start: string;
  horizon_days: number;
  timezone: string;
  status: 'draft' | 'active';
  version: number;
  created_at: string;
  updated_at: string;
  task_defs: TaskDef[];
  constraints: Constraint[];
  blocks: Block[];
}

export interface ConversationRecord {
  id: string;
  title: string;
  plan_id: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  kind: string;
  content: string;
  payload?: unknown;
}

export type SharedBlock = Block;

interface Meta { migrated?: boolean; visitor_id?: string; schema?: number }

const KV = 'kv';
export const uuid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export async function getMeta(): Promise<Meta> { return ((await getOne<Meta>(KV, 'meta')) ?? {}) as Meta; }
export async function setMeta(patch: Partial<Meta>): Promise<void> {
  await putOne(KV, 'meta', { ...(await getMeta()), ...patch });
}
export async function getVisitorId(): Promise<string> {
  const meta = await getMeta();
  if (meta.visitor_id) return meta.visitor_id;
  const id = uuid();
  await setMeta({ visitor_id: id });
  return id;
}

export async function listPlans(): Promise<PlanRecord[]> {
  return getAll<PlanRecord>('plans');
}
export async function getPlan(id: string): Promise<PlanRecord | undefined> {
  return getOne<PlanRecord>('plans', id);
}
export async function putPlan(rec: PlanRecord): Promise<void> {
  await putOne('plans', rec.id, rec);
}
export async function removePlan(id: string): Promise<void> {
  await queuePlanSessionWrite(() => planStorageTransaction(async (tx) => {
    tx.delete('plans', id);
    if (await tx.get<string | null>('kv', PLAN_SELECTION_KEY) === id) tx.put('kv', PLAN_SELECTION_KEY, null);
  }));
}
export async function planCount(): Promise<number> {
  return (await listPlans()).length;
}

export async function listConversations(): Promise<ConversationRecord[]> {
  const all = await getAll<ConversationRecord>('conversations');
  return all.filter((c) => c.status !== 'archived').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}
export async function getConversation(id: string): Promise<ConversationRecord | undefined> {
  return getOne<ConversationRecord>('conversations', id);
}
export async function putConversation(rec: ConversationRecord): Promise<void> {
  await putOne('conversations', rec.id, rec);
}
export async function removeConversationsForPlan(planId: string): Promise<void> {
  for (const c of await getAll<ConversationRecord>('conversations')) {
    if (c.plan_id === planId) { await removeMessages(c.id); await deleteOne('conversations', c.id); }
  }
}

export async function listMessages(conversationId: string): Promise<MessageRecord[]> {
  const all = await getAll<MessageRecord>('messages');
  return all.filter((m) => m.conversation_id === conversationId).sort((a, b) => a.seq - b.seq);
}
export async function appendMessage(m: MessageRecord): Promise<void> {
  await putOne('messages', [m.conversation_id, m.seq], m);
}
export async function deleteMessage(conversationId: string, seq: number): Promise<void> {
  await deleteOne('messages', [conversationId, seq]);
}
export async function removeMessages(conversationId: string): Promise<void> {
  for (const m of await getAll<MessageRecord>('messages')) {
    if (m.conversation_id === conversationId) await deleteOne('messages', [m.conversation_id, m.seq]);
  }
}

export async function listShared(): Promise<SharedBlock[]> {
  return (await getAll<SharedBlock>('shared')).sort((a, b) => a.start_utc.localeCompare(b.start_utc));
}
export async function putShared(block: SharedBlock): Promise<void> {
  await putOne('shared', block.id, block);
}
export async function deleteShared(id: string): Promise<void> {
  await deleteOne('shared', id);
}
export async function clearShared(): Promise<void> {
  for (const b of await getAll<SharedBlock>('shared')) await deleteOne('shared', b.id);
}

export async function getTombstones(): Promise<string[]> {
  return ((await getOne<string[]>(KV, 'shared_deletions')) ?? []);
}
export async function addTombstone(key: string): Promise<void> {
  const keys = await getTombstones();
  if (!keys.includes(key)) await putOne(KV, 'shared_deletions', [...keys, key]);
}

export async function getProfile(): Promise<Profile> {
  return ((await getOne<Profile>(KV, 'profile')) ?? { habits: '', learned: null, learned_at: null, updated_at: null }) as Profile;
}
export async function putProfile(p: Profile): Promise<void> {
  await putOne(KV, 'profile', p);
}

export interface StoredBlockHistory {
  entries: Record<string, import('@/store/useBlockHistory').BlockHistoryEntry[]>;
  redo: Record<string, import('@/store/useBlockHistory').BlockHistoryEntry[]>;
}
export async function getBlockHistory(): Promise<StoredBlockHistory> {
  return ((await getOne<StoredBlockHistory>(KV, 'block_history')) ?? { entries: {}, redo: {} });
}
export async function putBlockHistory(h: StoredBlockHistory): Promise<void> {
  await putOne(KV, 'block_history', h);
}

export async function deleteEverything(): Promise<void> {
  await queuePlanSessionWrite(() => clearAll());
}

// Only null-id drafts live in kv. Saved plan contents live exclusively in plans.
export const PLAN_DRAFT_KEY = 'plan_draft';
export const PLAN_SELECTION_KEY = 'plan_selection';
export const LEGACY_PLAN_MIGRATION_KEY = 'plan_v1_migrated';
let planSessionWrites: Promise<unknown> = Promise.resolve();
let planSessionError: unknown;
function queuePlanSessionWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = planSessionWrites.then(write);
  planSessionWrites = result.then(
    () => { planSessionError = undefined; },
    (err) => { planSessionError = err; },
  );
  return result;
}
export async function flushPlanSessionWrites(): Promise<void> {
  // Include writes appended while an earlier transaction was completing.
  let pending: Promise<unknown>;
  do { pending = planSessionWrites; await pending; } while (pending !== planSessionWrites);
  if (planSessionError !== undefined) throw planSessionError;
}

export async function readPlanSession() {
  await flushPlanSessionWrites();
  return {
    selection: await getOne<string | null>('kv', PLAN_SELECTION_KEY),
    draft: await getOne<PlanState>('kv', PLAN_DRAFT_KEY),
  };
}

export function writePlanSession(state: PlanState, consumeDraft = false): Promise<void> {
  const id = state.plan.id;
  const draft = id === null ? structuredClone(state) : undefined;
  return queuePlanSessionWrite(() => planStorageTransaction(async (tx) => {
    // A delayed selection cannot revive a deleted plan, even after another tab deletes it.
    if (id !== null && !await tx.get('plans', id)) return;
    if (draft) tx.put('kv', PLAN_DRAFT_KEY, draft);
    else if (consumeDraft) tx.delete('kv', PLAN_DRAFT_KEY);
    tx.put('kv', PLAN_SELECTION_KEY, id);
  }));
}

const planRecord = (s: PlanState, id: string): PlanRecord => ({
  ...s.plan, id, status: s.plan.status === 'active' ? 'active' : 'draft',
  task_defs: s.task_defs, constraints: s.constraints, blocks: s.blocks,
});
export async function hasLegacyPlanMigration(): Promise<boolean> {
  return await getOne('kv', LEGACY_PLAN_MIGRATION_KEY) === true;
}

/** Insert only: canonical records always win, irrespective of snapshot timestamps/versions. */
export function migrateLegacyPlan(state: PlanState | null): Promise<void> {
  return queuePlanSessionWrite(() => planStorageTransaction(async (tx) => {
    if (await tx.get('kv', LEGACY_PLAN_MIGRATION_KEY) === true) return;
    if (state) {
      const id = state.plan.id;
      if (id === null) {
        if (await tx.get('kv', PLAN_DRAFT_KEY) === undefined) tx.put('kv', PLAN_DRAFT_KEY, state);
      } else if (await tx.get('plans', id) === undefined) {
        tx.put('plans', id, planRecord(state, id));
      }
      if (await tx.get('kv', PLAN_SELECTION_KEY) === undefined) tx.put('kv', PLAN_SELECTION_KEY, id);
    }
    tx.put('kv', LEGACY_PLAN_MIGRATION_KEY, true);
  }));
}

/** Explicit JSON import, not a rendering update. Existing IDs are imported as a copy. */
export function importPlanSession(state: PlanState): Promise<PlanState> {
  const snapshot = structuredClone(state);
  return queuePlanSessionWrite(() => planStorageTransaction(async (tx) => {
    let id = snapshot.plan.id;
    if (id === null) {
      tx.put('kv', PLAN_DRAFT_KEY, snapshot);
    } else {
      if (await tx.get('plans', id)) {
        id = uuid();
        // A copied plan must not share block identities with the original (undo/conflict targets).
        snapshot.blocks = snapshot.blocks.map((block) => ({ ...block, id: uuid() }));
        snapshot.constraints = snapshot.constraints.map((constraint) => ({ ...constraint, id: uuid() }));
      }
      snapshot.plan.id = id;
      tx.put('plans', id, planRecord(snapshot, id));
    }
    tx.put('kv', PLAN_SELECTION_KEY, id);
    return snapshot;
  }));
}