import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const { rolldown } = require('rolldown');

export async function buildCrashRunner() {
  const out = path.join(root, 'build', 'crash-runner.mjs');
  const bundle = await rolldown({
    input: path.join(root, 'dev', 'crash-runner.ts'),
    resolve: {
      alias: {
        'npm:zod@3.25.76': 'zod',
        'npm:date-fns@4.4.0': 'date-fns',
        'npm:date-fns-tz@3.2.0': 'date-fns-tz',
      },
    },
  });
  await bundle.write({ file: out, format: 'esm' });
  await bundle.close();
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('build-crash-runner.mjs')) {
  const out = await buildCrashRunner();
  console.log('crash runner built:', out);
}