import { application } from '../functions/app.ts';
import { createMemoryDb } from './fake-db.ts';
import { createFakeQca, upstreamStream } from './fake-qca.ts';
const db = createMemoryDb();
const cannedSet = { type: 'constraint_set', plan_title: '本地测试计划', horizon_days: 7, task_defs: [{ key: 'math', title: '数学真题', category: 'study', duration_min: 90, frequency: { type: 'daily' } }, { key: 'words', title: '背单词', category: 'study', duration_min: 40, frequency: { type: 'daily' } }], constraints: [{ type: 'active_window', start: '07:00', end: '23:00' }, ...[1, 2, 3, 4, 5].map((weekday) => ({ type: 'busy_window', weekday, start: '09:00', end: '17:30', label: '上班' }))], clarifications_needed: [] };
const cannedFrames = [
  { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '```json\n' } } },
  { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '```json\n' + JSON.stringify(cannedSet) + '\n```' }] },
  { type: 'session.status', status: 'idle' },
];
const qca = createFakeQca({ openStream: async () => ({ body: upstreamStream(cannedFrames), close() {} }) });
const handle = application({ db, requireUser: (ctx) => { if (!ctx.user) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); return ctx.user; }, qca, config: { cloudApiOrigin: 'http://local', appScope: 'local-dev', modelId: 'local-fixture' } });
function visitorOf(request: Request): string {
  const m = request.headers.get('cookie')?.match(/(?:^|;\s*)dev_visitor=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : 'local-visitor';
}
console.log('Guidy local Function (FIXTURE, not real AI): http://127.0.0.1:8000');
Deno.serve({ hostname: '127.0.0.1', port: 8000 }, (request) => handle({ request, user: { id: visitorOf(request) }, requestId: crypto.randomUUID() }));