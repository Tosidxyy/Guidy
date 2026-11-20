import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const { rolldown } = require('rolldown');

// Shell 环境优先；其次 .env.local；最后 .env。密钥只留在本进程内。
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv(path.join(root, '.env.local'));
loadEnv(path.join(root, '.env'));

// 也可用 LOCAL_LLM_CONFIG 指向一个 JSON 配置（兼容 LIGHTMEM_* 字段），避免把密钥复制到仓库。
if (process.env.LOCAL_LLM_CONFIG) {
  const cfg = JSON.parse(readFileSync(process.env.LOCAL_LLM_CONFIG, 'utf8'));
  const mapping = {
    LOCAL_LLM_BASE_URL: cfg.LOCAL_LLM_BASE_URL ?? cfg.LIGHTMEM_BASE_URL,
    LOCAL_LLM_MODEL: cfg.LOCAL_LLM_MODEL ?? cfg.LIGHTMEM_MODEL,
    LOCAL_LLM_API_KEY: cfg.LOCAL_LLM_API_KEY ?? cfg.LIGHTMEM_API_KEY,
  };
  for (const [key, value] of Object.entries(mapping)) {
    if (process.env[key] === undefined && value) process.env[key] = String(value);
  }
  // 兜底供应商配置同样只留在本进程内。
  for (const [key, value] of Object.entries(cfg)) {
    if ((key.startsWith('DEEPSEEK_') || key.startsWith('BAILIAN_')) && process.env[key] === undefined && value) process.env[key] = String(value);
  }
}

const entry = process.argv[2] ?? 'dev/function-live.ts';
const outFile = path.join(root, 'build', 'dev-function.mjs');
mkdirSync(path.dirname(outFile), { recursive: true });

const bundle = await rolldown({
  input: path.join(root, entry),
  resolve: {
    alias: {
      'npm:zod@3.25.76': 'zod',
      'npm:date-fns@4.4.0': 'date-fns',
      'npm:date-fns-tz@3.2.0': 'date-fns-tz',
    },
  },
});
await bundle.write({ file: outFile, format: 'esm' });
await bundle.close();

globalThis.Deno = {
  env: { get: (key) => process.env[key] },
  serve: (options, handler) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
      const request = new Request(`http://${req.headers.host ?? `127.0.0.1:${options.port}`}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      try {
        const response = await handler(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (!response.body) { res.end(); return; }
        const reader = response.body.getReader();
        res.on('close', () => { void reader.cancel().catch(() => {}); });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once('drain', resolve));
        }
        res.end();
      } catch (error) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'local_dev_error', message: String(error?.message ?? error) } }));
      }
    });
    server.listen(options.port, options.hostname ?? '127.0.0.1');
    return server;
  },
};

await import(`file://${outFile.replace(/\\/g, '/')}`);