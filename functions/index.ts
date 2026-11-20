import { createDatabaseClient, createSiteContext, requireUser, errorResponse } from './_qoder/backend.mjs';
import { application } from './app.ts';
import { createLiveQca } from './qca/live.ts';
import { createOpenAiQca } from './qca/openai.ts';
import { createResilientQca, type QcaProvider } from './qca/fallback.ts';
const db = createDatabaseClient();
const config = {
  cloudApiOrigin: 'https://api.qoder.com.cn',
  appScope: 'guidy-site-01a1f4a2-f7b0-7779-9562-7602d7dfac2c',
  modelId: '',
};
// 兜底供应商：密钥只从平台 Secret 注入，缺失时该供应商自动跳过。
const fallbacks: QcaProvider[] = [];
const deepseekKey = Deno.env.get('DEEPSEEK_API_KEY');
if (deepseekKey) {
  fallbacks.push({
    name: 'deepseek',
    adapter: createOpenAiQca({
      baseUrl: Deno.env.get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com/v1',
      apiKey: deepseekKey,
      model: Deno.env.get('DEEPSEEK_MODEL') ?? 'deepseek-v4.1flash-1017',
    }),
  });
}
const bailianKey = Deno.env.get('BAILIAN_API_KEY');
if (bailianKey) {
  fallbacks.push({
    name: 'bailian',
    adapter: createOpenAiQca({
      baseUrl: Deno.env.get('BAILIAN_BASE_URL') ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: bailianKey,
      model: Deno.env.get('BAILIAN_MODEL') ?? 'deepseek-v4.1flash-1017',
    }),
  });
}
const primary = createLiveQca({ db, config });
const qca = fallbacks.length ? createResilientQca([{ name: 'qca', adapter: primary }, ...fallbacks]) : primary;
const handle = application({ db, requireUser, qca, config });
Deno.serve(async (request) => {
  let context;
  try { context = createSiteContext(request, { forwardApplicationCredentials: true }); return await handle(context); }
  catch (error) { return errorResponse(error, context?.requestId); }
});