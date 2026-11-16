import { describe, expect, it } from 'vitest';
import { clampMessage, MESSAGE_MAX } from '@/lib/markdown';

describe('ChatInput 提交前 clamp', () => {
  it('恰好 2000 字符不截断', () => {
    const s = 'b'.repeat(MESSAGE_MAX);
    expect(clampMessage(s).length).toBe(MESSAGE_MAX);
  });
  it('2001 字符截断到 2000', () => {
    expect(clampMessage('b'.repeat(MESSAGE_MAX + 1)).length).toBe(MESSAGE_MAX);
  });
});