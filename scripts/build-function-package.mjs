import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = 'build/function-package';

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const skip = (src) => src.includes('__tests__') || src.includes('migrations');
const keep = (src) => !skip(src);

await cp('functions', `${OUT}/functions`, { recursive: true, filter: keep });
await cp('shared', `${OUT}/shared`, { recursive: true, filter: keep });
await mkdir(`${OUT}/lib`, { recursive: true });
await cp('lib/describe.ts', `${OUT}/lib/describe.ts`);

// The packager requires index.ts at the ZIP root; the real entry stays in
// functions/ so every original relative import (../shared, ../lib) resolves
// inside the package.
await writeFile(`${OUT}/index.ts`, "import './functions/index.ts';\n");

if (!existsSync(`${OUT}/functions/index.ts`)) throw new Error('function package missing entry');
console.log(`function package ready: ${OUT}`);