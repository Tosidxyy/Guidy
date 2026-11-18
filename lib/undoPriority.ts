export function pickUndoSource(blockAt?: number, localAt?: number): 'block' | 'local' | null {
  if (blockAt === undefined && localAt === undefined) return null;
  if (blockAt === undefined) return 'local';
  if (localAt === undefined) return 'block';
  return blockAt >= localAt ? 'block' : 'local';
}