import { describe, expect, it } from 'vitest';
import { pickUndoSource } from '@/lib/undoPriority';

describe('pickUndoSource', () => {
  it('都没有 → null', () => expect(pickUndoSource(undefined, undefined)).toBeNull());
  it('只有块历史 → block', () => expect(pickUndoSource(10, undefined)).toBe('block'));
  it('只有本地历史 → local', () => expect(pickUndoSource(undefined, 10)).toBe('local'));
  it('较新的胜出', () => {
    expect(pickUndoSource(11, 10)).toBe('block');
    expect(pickUndoSource(10, 11)).toBe('local');
    expect(pickUndoSource(10, 10)).toBe('block');
  });
});