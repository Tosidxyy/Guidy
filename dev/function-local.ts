import { application } from '../functions/app.ts';
import { createMemoryDb } from './fake-db.ts';
import { createFakeQca, upstreamStream } from './fake-qca.ts';
const db = createMemoryDb();
const cannedSet = { type: 'constraint_set', plan_title: '本地示例计划', horizon_days: 7, task_defs: [{ key: 'math', title: '数学真题', category: 'study', duration_min: 90, frequency: { type: 'daily' } }], constraints: [{ type: 'active_window', start: '07:00', end: '23:00' }], clarifications_needed: [] };
const cannedFrames = [
  { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '【本地 fixture】已生成示例约束：\n' } } },
  { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '【本地 fixture】已生成示例约束：\n```json\n' + JSON.stringify(cannedSet) + '\n```' }] },
  { type: 'session.status', status: 'idle' },
];
const qca = createFakeQca({ openStream: async () => ({ body: upstreamStream(cannedFrames), close() {} }) });
const handle = application({ db, requireUser: () => ({ id: 'local-visitor' }), qca, config: { cloudApiOrigin: 'http://local', appScope: 'local-dev', modelId: 'local-fixture' } });
console.log('Guidy local Function (FIXTURE, not real AI): http://127.0.0.1:8000');
Deno.serve({ hostname: '127.0.0.1', port: 8000 }, (request) => handle({ request, user: { id: 'local-visitor' }, requestId: crypto.randomUUID() }));