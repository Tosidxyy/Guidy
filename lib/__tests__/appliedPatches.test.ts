import { describe, expect, it } from 'vitest';
import { createAppliedPatches, patchSignature } from '@/lib/appliedPatches';
import type { PatchArtifact } from '@/shared/schemas';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

const patch: PatchArtifact = {
  type: 'patch',
  summary: '把阅读挪到晚上',
  ops: [{ op: 'move_block', id: 'b1', start_utc: '2026-11-20T12:00:00.000Z', end_utc: '2026-11-20T12:45:00.000Z' }],
};

describe('patchSignature', () => {
  it('键序不同的同一份 ops 视为同一签名', () => {
    const reordered = {
      ops: [{ end_utc: '2026-11-20T12:45:00.000Z', start_utc: '2026-11-20T12:00:00.000Z', id: 'b1', op: 'move_block' }],
      summary: '把阅读挪到晚上',
      type: 'patch',
    } as PatchArtifact;
    expect(patchSignature(reordered)).toBe(patchSignature(patch));
  });

  it('ops 变化则签名不同', () => {
    const changed: PatchArtifact = { ...patch, ops: [{ ...patch.ops[0], end_utc: '2026-11-20T13:00:00.000Z' } as PatchArtifact['ops'][number]] };
    expect(patchSignature(changed)).not.toBe(patchSignature(patch));
  });
});

describe('createAppliedPatches', () => {
  it('标记后同一对话视为已应用，其他对话不受影响', () => {
    const store = createAppliedPatches(memoryStorage());
    expect(store.isApplied('c1', patch)).toBe(false);
    store.mark('c1', patch);
    expect(store.isApplied('c1', patch)).toBe(true);
    expect(store.isApplied('c2', patch)).toBe(false);
  });

  it('没有对话 id 或没有存储时不报错', () => {
    const store = createAppliedPatches(null);
    store.mark('c1', patch);
    expect(store.isApplied('c1', patch)).toBe(false);
    expect(store.isApplied(null, patch)).toBe(false);
  });

  it('重复标记不重复写入', () => {
    const storage = memoryStorage();
    const store = createAppliedPatches(storage);
    store.mark('c1', patch);
    store.mark('c1', patch);
    const raw = JSON.parse(storage.getItem('guidy.applied-patches.v1')!);
    expect(raw.c1).toHaveLength(1);
  });
});