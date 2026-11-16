import type { Block, DiffResult } from '../types';

export function diffBlocks(before: Block[], after: Block[]): DiffResult {
  const beforeMap = new Map(before.map((b) => [b.id, b]));
  const afterMap = new Map(after.map((b) => [b.id, b]));
  const added: string[] = [];
  const removed: string[] = [];
  const moved: { id: string; from: string; to: string }[] = [];
  for (const [id, b] of afterMap) {
    const old = beforeMap.get(id);
    if (!old) added.push(id);
    else if (old.start_utc !== b.start_utc || old.end_utc !== b.end_utc) {
      moved.push({ id, from: old.start_utc, to: b.start_utc });
    }
  }
  for (const id of beforeMap.keys()) if (!afterMap.has(id)) removed.push(id);
  return { added, removed, moved };
}