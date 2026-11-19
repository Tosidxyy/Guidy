// 把 shared/ 与 vendor/zod 同步进 functions/，使 Function 包自包含（edge-runtime 只打包 functionDirectory）。
import { cpSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function copyTs(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (statSync(s).isDirectory()) copyTs(s, d);
    else if (name.endsWith('.ts')) cpSync(s, d);
  }
}

rmSync(path.join(root, 'functions/shared'), { recursive: true, force: true });
rmSync(path.join(root, 'functions/vendor'), { recursive: true, force: true });
copyTs(path.join(root, 'shared'), path.join(root, 'functions/shared'));
mkdirSync(path.join(root, 'functions/vendor'), { recursive: true });
cpSync(path.join(root, 'vendor/zod.ts'), path.join(root, 'functions/vendor/zod.ts'));
cpSync(path.join(root, 'vendor/zod-v3'), path.join(root, 'functions/vendor/zod-v3'), { recursive: true });
console.log('function package synced: shared + vendor/zod');