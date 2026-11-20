import { randomUUID } from 'node:crypto';
import type { Db, DbQuery } from '../functions/db.ts';
const ID_TABLES = new Set(['plans', 'task_defs', 'constraints', 'blocks', 'conversations', 'messages', 'template_uses', 'recovery_codes']);
const TS_TABLES = new Set(['plans', 'conversations', 'messages', 'dispatch_intents', 'commit_log', 'cloud_bindings', 'constraints', 'blocks', 'task_defs', 'commit_claims']);
export interface MemoryDb extends Db { tables: Record<string, any[]>; reset(): void }
export function createMemoryDb(seed: Record<string, any[]> = {}): MemoryDb {
  const tables: Record<string, any[]> = {};
  const reset = () => { for (const k of Object.keys(tables)) delete tables[k]; for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r })); };
  reset();
  const ensure = (t: string) => (tables[t] ??= []);
  return {
    tables, reset,
    from(table: string): DbQuery {
      const rowsRef = ensure(table);
      const filters: [string, unknown][] = []; const order: [string, boolean][] = [];
      let mode: 'read' | 'insert' | 'update' | 'delete' = 'read';
      let values: any; let conflict: string[] | null = null; let columns: string | null = null; let count = 1000;
      // 与云端 PostgREST 一致：写操作只有显式 .select() 才返回行，否则 data 为空。
      let returning = false;
      const project = (row: any) => (!columns || columns === '*') ? { ...row } : Object.fromEntries(columns.split(',').map((c) => [c.trim(), row[c.trim()]]));
      const q: DbQuery = {
        select(cols) { columns = cols ?? null; returning = true; return q; },
        eq(k, v) { if (v === null) throw Object.assign(new Error('database_invalid_operation'), { code: 'database_invalid_operation', status: 400 }); filters.push([k, v]); return q; },
        is(k, v) { filters.push([k, v]); return q; },
        order(k, o) { order.push([k, o?.ascending !== false]); return q; },
        limit(n) { count = n; return q; },
        insert(v) { mode = 'insert'; values = v; return q; },
        insertIfAbsent(v, o) { mode = 'insert'; values = v; conflict = o.onConflict.split(','); return q; },
        update(v) { mode = 'update'; values = v; return q; },
        delete() { mode = 'delete'; return q; },
        then(onF, onR) {
          return Promise.resolve().then(() => {
            let result: any[];
            const match = (row: any) => filters.every(([k, v]) => row[k] === v);
            if (mode === 'insert') {
              const list = Array.isArray(values) ? values : [values];
              result = [];
              for (const v of list) {
                if (conflict && rowsRef.some((row) => conflict!.every((k) => row[k] === v[k]))) continue;
                // 与云端一致：blocks.plan_id NOT NULL 且外键引用 plans(id)。
                if (table === 'blocks' && (v.plan_id == null || !(tables.plans ?? []).some((p) => p.id === v.plan_id))) {
                  return { data: null, error: { code: 'database_constraint_violation', status: 409 } };
                }
                const row = { ...v };
                if (ID_TABLES.has(table) && row.id === undefined) row.id = randomUUID();
                // 与云端一致：主键（id）必须唯一；版本化数据不得跨版本复用同一 id。
                if (ID_TABLES.has(table) && row.id !== undefined && rowsRef.some((r) => r.id === row.id)) {
                  return { data: null, error: { code: 'database_constraint_violation', status: 409 } };
                }
                // 与云端一致：messages 有 UNIQUE(conversation_id, seq)。
                if (table === 'messages' && rowsRef.some((r) => r.conversation_id === v.conversation_id && r.seq === v.seq)) {
                  return { data: null, error: { code: 'database_constraint_violation', status: 409 } };
                }
                if (TS_TABLES.has(table)) { row.created_at ??= new Date().toISOString(); if ('updated_at' in row || table === 'plans' || table === 'conversations') row.updated_at ??= new Date().toISOString(); }
                rowsRef.push(row); result.push(row);
              }
            } else {
              result = rowsRef.filter(match);
              if (mode === 'update') result.forEach((row) => Object.assign(row, values));
              if (mode === 'delete') { for (const row of result) rowsRef.splice(rowsRef.indexOf(row), 1); }
            }
            for (const [k, asc] of [...order].reverse()) result = [...result].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
            const out = mode !== 'read' && !returning ? [] : result.slice(0, count).map(project);
            return { data: out, error: null };
          }).then(onF as any, onR as any);
        },
      };
      return q;
    },
  };
}