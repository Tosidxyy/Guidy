import { rolldown } from 'rolldown';
import { mkdir, rm } from 'node:fs/promises';

const OUT = 'build/function-package';

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// The Sites packager zips only this directory and its bundler resolves no
// import map or npm specifiers, so third-party deps are inlined here and only
// the platform-injected _qoder SDK stays external.
const bundle = await rolldown({
  input: 'functions/index.ts',
  external: (id) => id.includes('_qoder/'),
});
await bundle.write({ file: `${OUT}/index.ts`, format: 'esm' });
await bundle.close();

console.log(`function package ready: ${OUT}/index.ts`);