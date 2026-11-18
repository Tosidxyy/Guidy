import { application } from '../functions/app.ts';
import { createMemoryDb } from './fake-db.ts';
import { createOpenAiQca } from './qca-openai.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const baseUrl = Deno.env.get('LOCAL_LLM_BASE_URL') ?? '';
const model = Deno.env.get('LOCAL_LLM_MODEL') ?? '';
const apiKey = Deno.env.get('LOCAL_LLM_API_KEY') ?? '';
if (!baseUrl || !model || !apiKey) {
  throw new Error('缺少本地模型配置：请设置 LOCAL_LLM_BASE_URL、LOCAL_LLM_MODEL、LOCAL_LLM_API_KEY（可写入 .env.local）');
}

// 本地调试用持久化：重启后保留计划与对话，避免每次丢失测试现场。
const dbFile = Deno.env.get('LOCAL_DB_FILE') ?? 'build/dev-db.json';
let seed: Record<string, any[]> = {};
try {
  if (existsSync(dbFile)) seed = JSON.parse(readFileSync(dbFile, 'utf8'));
} catch {
  seed = {};
}
const db = createMemoryDb(seed);
setInterval(() => {
  try {
    mkdirSync(dirname(dbFile), { recursive: true });
    writeFileSync(dbFile, JSON.stringify(db.tables));
  } catch {
    /* 本地持久化失败不影响请求 */
  }
}, 2000);
const qca = createOpenAiQca({ baseUrl, model, apiKey });
const handle = application({ db, requireUser: (ctx) => { if (!ctx.user) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); return ctx.user; }, qca, config: { cloudApiOrigin: 'http://local', appScope: 'local-live', modelId: model } });
function visitorOf(request: Request): string {
  const m = request.headers.get('cookie')?.match(/(?:^|;\s*)dev_visitor=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : 'local-visitor';
}
console.log(`Guidy local Function (LIVE OpenAI-compatible: ${model}): http://127.0.0.1:8000`);
Deno.serve({ hostname: '127.0.0.1', port: 8000 }, (request) => handle({ request, user: { id: visitorOf(request) }, requestId: crypto.randomUUID() }));