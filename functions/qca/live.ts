import { createCloudAgentsClient, ensureCloudResources } from './cloud-agents.mjs';
import { createDbCoordinator } from './coordinator.ts';
import { buildSystemPrompt } from '../prompt.ts';
import { fail } from '../errors.ts';
import type { Db } from '../db.ts';
import type { QcaAdapter, QcaBinding } from '../types.ts';
export function createLiveQca({ db, config }: { db: Db; config: { cloudApiOrigin: string; appScope: string; modelId: string } }): QcaAdapter {
  const client = createCloudAgentsClient({ origin: config.cloudApiOrigin });
  const coordinator = createDbCoordinator(db);
  let modelPromise: Promise<string> | null = null;
  let bindingPromise: Promise<QcaBinding> | null = null;
  const resolveModel = (): Promise<string> => {
    if (config.modelId) return Promise.resolve(config.modelId);
    modelPromise ??= client.request('/api/v1/cloud/models').then((r: any) => {
      const m = (r?.data ?? []).find((x: any) => x.enabled !== false);
      if (!m?.id) fail('service_unavailable', 503);
      return m.id as string;
    }).catch((e) => { modelPromise = null; throw e; });
    return modelPromise;
  };
  return {
    ensureBinding(scope) {
      bindingPromise ??= (async () => {
        const model = await resolveModel();
        return ensureCloudResources({
          client, coordinator, applicationScope: scope,
          agent: { name: 'Guidy 排程助手', model, system: buildSystemPrompt(), tools: [], metadata: { app: 'guidy', purpose: 'planning' } },
          environment: { name: 'Guidy 排程环境', config: { type: 'cloud' } },
        }) as Promise<QcaBinding>;
      })().catch((e) => { bindingPromise = null; throw e; });
      return bindingPromise;
    },
    async createSession(binding, title, metadata) {
      const r: any = await client.request('/api/v1/cloud/sessions', { method: 'POST', body: { ...binding, title, metadata } });
      if (!r?.id) fail('upstream_error', 502);
      return { id: r.id };
    },
    async sendEvents(sessionId, text, idempotencyKey) {
      const r: any = await client.request(`/api/v1/cloud/sessions/${sessionId}/events`, {
        method: 'POST', body: { events: [{ type: 'user.message', content: [{ type: 'text', text }] }] }, idempotencyKey,
      });
      return { eventIds: (r?.data ?? []).map((e: any) => e.id).filter(Boolean) };
    },
    openStream(sessionId, opts) { return client.openStream(sessionId, opts); },
    async listEvents(sessionId, opts) {
      const r: any = await client.request(`/api/v1/cloud/sessions/${sessionId}/events?order=${opts.order ?? 'asc'}&limit=${opts.limit ?? 100}`);
      return { data: r?.data ?? [], has_more: !!r?.has_more, next_page: r?.next_page };
    },
  };
}