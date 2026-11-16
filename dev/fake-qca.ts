import type { QcaAdapter } from '../functions/types.ts';
export function createFakeQca(overrides: Partial<QcaAdapter> = {}): QcaAdapter {
  return {
    async ensureBinding() { return { agent: { type: 'agent', id: 'agent_fake', version: 1 }, environment_id: 'env_fake' }; },
    async createSession() { return { id: 'sess_fake' }; },
    async sendEvents() { return { eventIds: ['evt_fake'] }; },
    async openStream() { return { body: new ReadableStream({ start(c) { c.close(); } }), close() {} }; },
    async listEvents() { return { data: [], has_more: false }; },
    ...overrides,
  };
}