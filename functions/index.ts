import { createDatabaseClient, createSiteContext, requireUser, errorResponse } from './_qoder/backend.mjs';
import { application } from './app.ts';
import { createLiveQca } from './qca/live.ts';
const db = createDatabaseClient();
const config = {
  cloudApiOrigin: 'https://api.qoder.com.cn',
  appScope: 'guidy-site-01a1f4a2-f7b0-7779-9562-7602d7dfac2c',
  modelId: '',
};
const handle = application({ db, requireUser, qca: createLiveQca({ db, config }), config });
Deno.serve(async (request) => {
  let context;
  try { context = createSiteContext(request, { forwardApplicationCredentials: true }); return await handle(context); }
  catch (error) { return errorResponse(error, context?.requestId); }
});