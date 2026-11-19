// 崩溃注入执行器：磁盘持久化 + 指定写操作前后 process.exit，由父进程在新进程中读回校验。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createMemoryDb } from './fake-db.ts';
import { createFakeQca } from './fake-qca.ts';
import { application } from '../functions/app.ts';
import type { Db } from '../functions/db.ts';

const dbFile = process.env.CRASH_DB_FILE!;
const reqFile = process.env.CRASH_REQ_FILE!;
const visitor = process.env.CRASH_VISITOR ?? 'v';
const crashTable = process.env.CRASH_TABLE ?? '';
const crashOp = process.env.CRASH_OP ?? '';
const crashIndex = Number(process.env.CRASH_INDEX ?? 0);
const crashMode = process.env.CRASH_MODE ?? 'after';

mkdirSync(path.dirname(dbFile), { recursive: true });
const seed = existsSync(dbFile) ? JSON.parse(readFileSync(dbFile, 'utf8')) : {};
const base = createMemoryDb(seed);

const persist = () => writeFileSync(dbFile, JSON.stringify(base.tables));
const counters = new Map<string, number>();

function fileDb(): Db {
  const wrap = (q: any): any => new Proxy(q, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      if (prop === 'then') {
        return (onF: any, onR: any) => v.apply(target, [onF, onR]);
      }
      return (...args: any[]) => {
        const table = String(target.__table ?? '');
        const op = String(prop);
        let hit = false;
        if (['insert', 'insertIfAbsent', 'update', 'delete'].includes(op) && table === crashTable && op === crashOp) {
          const count = (counters.get(`${table}:${op}`) ?? 0) + 1;
          counters.set(`${table}:${op}`, count);
          hit = count === crashIndex;
          if (hit && crashMode === 'before') { persist(); process.exit(1); }
        }
        const r = v.apply(target, args);
        const wrapped = r === target ? wrap(target) : r;
        if (hit && crashMode === 'after') {
          // 写入已完成：等待该次查询结算后持久化并退出（模拟进程死亡）。
          const origThen = wrapped.then?.bind(wrapped);
          if (origThen) {
            wrapped.then = (f: any, rej: any) => origThen((res: any) => { persist(); process.exit(1); return res; }, rej);
          }
        }
        return wrapped;
      };
    },
  });
  return { from: (t: string) => { const q: any = base.from(t); q.__table = t; return wrap(q); } };
}

const deps = {
  db: fileDb(),
  requireUser: () => ({ id: visitor }),
  qca: createFakeQca(),
  config: { cloudApiOrigin: 'http://local', appScope: 'crash', modelId: 'fake', claimTtlMs: Number(process.env.CRASH_TTL ?? 120000) },
} as any;

const req = JSON.parse(readFileSync(reqFile, 'utf8'));
const app = application(deps);
const ctx = {
  request: new Request('http://x/functions/v1/app/api/plans/commit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
  }),
  user: { id: visitor },
} as any;

const res = await app(ctx);
persist();
const body = await res.json();
console.log(JSON.stringify({ status: res.status, body }));
process.exit(0);