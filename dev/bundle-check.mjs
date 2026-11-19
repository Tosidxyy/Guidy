import * as esbuild from 'esbuild-wasm';

const result = await esbuild.build({
  entryPoints: ['functions/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'esnext',
  write: false,
  logLevel: 'silent',
  metafile: true,
});
for (const w of result.warnings) console.log('WARN', w.text, w.location?.file, w.location?.line);
const out = result.outputFiles[0];
console.log('BUNDLE_OK bytes=' + out.contents.length);
const inputs = Object.keys(result.metafile.inputs);
console.log('modules=' + inputs.length);
console.log(inputs.filter((i) => !i.includes('vendor/zod-v3')).join('\n'));