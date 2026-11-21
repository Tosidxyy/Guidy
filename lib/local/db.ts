// 本机存储：浏览器用 IndexedDB，测试/无 IndexedDB 环境退化为进程内 Map。
// 只存数据，不做业务；业务在 lib/local/domain.ts。

const DB_NAME = 'guidy-local';
const DB_VERSION = 1;
const STORES = ['plans', 'conversations', 'messages', 'shared', 'kv'] as const;
export type StoreName = typeof STORES[number];

let dbPromise: Promise<IDBDatabase> | null = null;
const memory = new Map<StoreName, Map<IDBValidKey, unknown>>();
let memoryWrites: Promise<unknown> = Promise.resolve();
function memoryWrite<T>(run: () => T | Promise<T>): Promise<T> {
  const result = memoryWrites.then(run);
  memoryWrites = result.catch(() => undefined);
  return result;
}
const memStore = (name: StoreName) => {
  let s = memory.get(name);
  if (!s) { s = new Map(); memory.set(name, s); }
  return s;
};
export const hasIndexedDb = () => typeof indexedDB !== 'undefined';

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('plans')) db.createObjectStore('plans', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: ['conversation_id', 'seq'] });
        s.createIndex('by_conversation', 'conversation_id');
      }
      if (!db.objectStoreNames.contains('shared')) db.createObjectStore('shared', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAll<T>(name: StoreName): Promise<T[]> {
  if (!hasIndexedDb()) return [...memStore(name).values()] as T[];
  const db = await openDb();
  const tx = db.transaction(name, 'readonly');
  const req = tx.objectStore(name).getAll();
  const out = await new Promise<T[]>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
  return out;
}

export async function getOne<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  if (!hasIndexedDb()) return memStore(name).get(key) as T | undefined;
  const db = await openDb();
  const tx = db.transaction(name, 'readonly');
  const req = tx.objectStore(name).get(key);
  return new Promise<T | undefined>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function putOne(name: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
  if (!hasIndexedDb()) return memoryWrite(() => { memStore(name).set(key, value); });
  const db = await openDb();
  const tx = db.transaction(name, 'readwrite');
  if (name === 'kv') tx.objectStore(name).put(value, key);
  else tx.objectStore(name).put(value);
  await txDone(tx);
}

export async function deleteOne(name: StoreName, key: IDBValidKey): Promise<void> {
  if (!hasIndexedDb()) return memoryWrite(() => { memStore(name).delete(key); });
  const db = await openDb();
  const tx = db.transaction(name, 'readwrite');
  tx.objectStore(name).delete(key);
  await txDone(tx);
}

export async function clearAll(): Promise<void> {
  if (!hasIndexedDb()) return memoryWrite(() => { memory.clear(); });
  const db = await openDb();
  const tx = db.transaction([...STORES], 'readwrite');
  for (const s of STORES) tx.objectStore(s).clear();
  await txDone(tx);
}

/** Plan/session writes share one transaction so selection never precedes durable data. */
export interface PlanStorageTransaction {
  get<T>(store: 'plans' | 'kv', key: string): Promise<T | undefined>;
  put(store: 'plans' | 'kv', key: string, value: unknown): void;
  delete(store: 'plans' | 'kv', key: string): void;
}

export async function planStorageTransaction<T>(run: (tx: PlanStorageTransaction) => Promise<T>): Promise<T> {
  if (!hasIndexedDb()) {
    return memoryWrite(async () => {
      const stores = { plans: new Map(memStore('plans')), kv: new Map(memStore('kv')) };
      const value = await run({
        get: async <V>(store: 'plans' | 'kv', key: string) => structuredClone(stores[store].get(key)) as V | undefined,
        put: (store, key, data) => { stores[store].set(key, structuredClone(data)); },
        delete: (store, key) => { stores[store].delete(key); },
      });
      memory.set('plans', stores.plans);
      memory.set('kv', stores.kv);
      return value;
    });
  }
  const db = await openDb();
  const tx = db.transaction(['plans', 'kv'], 'readwrite');
  const done = txDone(tx);
  try {
    const value = await run({
      get: <V>(store: 'plans' | 'kv', key: string) => new Promise<V | undefined>((resolve, reject) => {
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as V | undefined);
        req.onerror = () => reject(req.error);
      }),
      put: (store, key, data) => {
        if (store === 'kv') tx.objectStore(store).put(data, key);
        else tx.objectStore(store).put(data);
      },
      delete: (store, key) => { tx.objectStore(store).delete(key); },
    });
    await done;
    return value;
  } catch (err) {
    try { tx.abort(); } catch { /* Already aborted/completed. */ }
    await done.catch(() => undefined);
    throw err;
  }
}

/** 仅测试使用：重置内存态。 */
export function __resetMemory() { memory.clear(); }