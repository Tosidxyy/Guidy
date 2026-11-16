import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { fail } from '../errors.ts';
export interface BindingRecord { state: string; id: string | null; version: number; fingerprint: string | null }
export interface Lease { read(): Promise<BindingRecord | null>; write(rec: { state: string; id?: string | null; version?: number; fingerprint?: string | null }): Promise<void>; assertHeld(): Promise<void> }
export interface Coordinator { withLock<T>(key: string, fn: (lease: Lease) => Promise<T>): Promise<T> }
const LEASE_TTL_MS = 30_000;
export function createDbCoordinator(db: Db): Coordinator {
  return {
    async withLock(key, fn) {
      const token = crypto.randomUUID();
      const nowIso = () => new Date().toISOString();
      rows(await db.from('cloud_bindings').insertIfAbsent(
        { key, state: null, resource_id: null, version: 0, fingerprint: null, lease_token: null, updated_at: nowIso() },
        { onConflict: 'key' },
      ));
      let acquired = false;
      for (let attempt = 0; attempt < 5 && !acquired; attempt++) {
        const row = rows(await db.from('cloud_bindings').select('lease_token,updated_at').eq('key', key).limit(1))[0];
        const held = row?.lease_token != null && Date.now() - Date.parse(row.updated_at) < LEASE_TTL_MS;
        if (held) { await new Promise((r) => setTimeout(r, 50)); continue; }
        const got = rows(await db.from('cloud_bindings').update({ lease_token: token, updated_at: nowIso() })
          .eq('key', key).eq('lease_token', row?.lease_token ?? null).select('key'));
        acquired = got.length > 0;
      }
      if (!acquired) fail('service_unavailable', 503);
      const lease: Lease = {
        async read() {
          const r = rows(await db.from('cloud_bindings').select('state,resource_id,version,fingerprint').eq('key', key).limit(1))[0];
          if (!r || r.state == null) return null;
          return { state: r.state, id: r.resource_id, version: r.version, fingerprint: r.fingerprint };
        },
        async write(rec) {
          rows(await db.from('cloud_bindings').update({ state: rec.state, resource_id: rec.id ?? null, version: rec.version ?? 0, fingerprint: rec.fingerprint ?? null, updated_at: nowIso() })
            .eq('key', key).eq('lease_token', token).select('key'));
        },
        async assertHeld() {
          const r = rows(await db.from('cloud_bindings').select('lease_token').eq('key', key).limit(1))[0];
          if (r?.lease_token !== token) fail('service_unavailable', 503);
        },
      };
      try { return await fn(lease); }
      finally {
        await db.from('cloud_bindings').update({ lease_token: null, updated_at: nowIso() }).eq('key', key).eq('lease_token', token);
      }
    },
  };
}