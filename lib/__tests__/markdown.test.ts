import { describe, expect, it } from 'vitest';
import { clampMessage, sanitizeSchema, MESSAGE_MAX } from '@/lib/markdown';

describe('clampMessage', () => {
  it('短文本原样返回', () => {
    expect(clampMessage('你好')).toBe('你好');
  });
  it('超长截断到 2000', () => {
    const s = clampMessage('a'.repeat(MESSAGE_MAX + 50));
    expect(s.length).toBe(MESSAGE_MAX);
  });
});

describe('sanitizeSchema', () => {
  it('禁止 script/style/iframe 标签', () => {
    expect(sanitizeSchema.tagNames).not.toContain('script');
    expect(sanitizeSchema.tagNames).not.toContain('style');
    expect(sanitizeSchema.tagNames).not.toContain('iframe');
  });
  it('通配属性不含 style 与 on* 事件', () => {
    const star = sanitizeSchema.attributes['*'] as string[];
    expect(star).not.toContain('style');
    expect(star.some((a) => String(a).startsWith('on'))).toBe(false);
  });
});