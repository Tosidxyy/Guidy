import { createDatabaseClient, createSiteContext, requireUser, errorResponse } from './_qoder/backend.mjs';
import { application } from './app.ts';
import { createLiveQca } from './qca/live.ts';
const db = createDatabaseClient();
const config = {
  cloudApiOrigin: 'https://api.qoder.com.cn',
  appScope: 'guidy-site-01a1e421-fb71-7745-9db4-db763e874017',
  modelId: '',
};
const handle = application({ db, requireUser, qca: createLiveQca({ db, config }), config });
Deno.serve(async (request) => {
  let context;
  try { context = createSiteContext(request); return await handle(context); }
  catch (error) { return errorResponse(error, context?.requestId); }
});