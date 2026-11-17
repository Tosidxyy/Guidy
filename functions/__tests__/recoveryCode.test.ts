import { describe, expect, it } from 'vitest';
import { generateCode, normalizeCode, formatCode, isValidCode } from '../recovery';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('recovery code pure functions', () => {
  it('generateCode: 32 字符 Crockford base32，两次不同', () => {
    const a = generateCode();
    const b = generateCode();
    expect(a).toHaveLength(32);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
    expect(b).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
    expect(a).not.toBe(b);
  });
  it('normalizeCode: 去连字符/空格、大写、O→0 I/L→1', () => {
    expect(normalizeCode('abcd-efgh ijkl')).toBe('ABCDEFGH1JK1');
    expect(normalizeCode('oooo')).toBe('0000');
    expect(normalizeCode('il10')).toBe('1110');
    expect(normalizeCode(' 0123-4567 ')).toBe('01234567');
  });
  it('formatCode: 8 组×4 连字符', () => {
    expect(formatCode(ALPHABET)).toBe('0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ');
  });
  it('往返：normalize(format(x)) === x', () => {
    for (let i = 0; i < 20; i++) {
      const x = generateCode();
      expect(normalizeCode(formatCode(x))).toBe(x);
    }
  });
  it('isValidCode: 仅接受 32 位 Crockford 字符', () => {
    expect(isValidCode(ALPHABET)).toBe(true);
    expect(isValidCode('0'.repeat(31))).toBe(false);
    expect(isValidCode('0'.repeat(33))).toBe(false);
    expect(isValidCode('U'.repeat(32))).toBe(false);
    expect(isValidCode('0'.repeat(31) + '!')).toBe(false);
    expect(isValidCode('')).toBe(false);
  });
});