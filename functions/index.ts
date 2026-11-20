import { createDatabaseClient, createSiteContext, requireUser, errorResponse } from './_qoder/backend.mjs';
import { application } from './app.ts';
import { createOpenAiQca } from './qca/openai.ts';
import { createResilientQca, type QcaProvider } from './qca/fallback.ts';
import type { QcaAdapter } from './types.ts';
const db = createDatabaseClient();
const config = {
  cloudApiOrigin: 'https://api.qoder.com.cn',
  appScope: 'guidy-site-01a1f4a2-f7b0-7779-9562-7602d7dfac2c',
  modelId: '',
};
// 默认走用户环境变量注入的 OpenAI 兼容供应商（DeepSeek → Bailian），不再依赖 Qoder 云端 QCA。
// 密钥只从平台 Secret 注入，缺失时该供应商自动跳过。
const providers: QcaProvider[] = [];
const deepseekKey = Deno.env.get('DEEPSEEK_API_KEY');
if (deepseekKey) {
  providers.push({
    name: 'deepseek',
    adapter: createOpenAiQca({
      baseUrl: Deno.env.get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com/v1',
      apiKey: deepseekKey,
      model: Deno.env.get('DEEPSEEK_MODEL') ?? 'deepseek-flash',
    }, db),
  });
}
const bailianKey = Deno.env.get('BAILIAN_API_KEY');
if (bailianKey) {
  providers.push({
    name: 'bailian',
    adapter: createOpenAiQca({
      baseUrl: Deno.env.get('BAILIAN_BASE_URL') ?? 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: bailianKey,
      model: Deno.env.get('BAILIAN_MODEL') ?? 'deepseek-v4.1-flash-1017',
    }, db),
  });
}
const notConfigured: QcaAdapter = {
  async ensureBinding() { throw Object.assign(new Error('ai_not_configured'), { code: 'ai_not_configured', status: 503 }); },
  async createSession() { throw Object.assign(new Error('ai_not_configured'), { code: 'ai_not_configured', status: 503 }); },
  async sendEvents() { throw Object.assign(new Error('ai_not_configured'), { code: 'ai_not_configured', status: 503 }); },
  async openStream() { throw Object.assign(new Error('ai_not_configured'), { code: 'ai_not_configured', status: 503 }); },
  async listEvents() { return { data: [], has_more: false }; },
};
// 按轮 failover：首选供应商配额/鉴权/上游错误自动落下一家，并下发「切换备用模型重试」提示。
const qca = providers.length ? createResilientQca(providers) : notConfigured;
const handle = application({ db, requireUser, qca, config });
Deno.serve(async (request) => {
  let context;
  try { context = createSiteContext(request, { forwardApplicationCredentials: true }); return await handle(context); }
  catch (error) { return errorResponse(error, context?.requestId); }
});