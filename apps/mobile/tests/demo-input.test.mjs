import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDemoCode } from '../src/auth/demoInput.ts';

test('formatted and full-width pasted demo digits become the same six digit input', () => {
  for (const raw of ['123 456', '123-456', '１２３４５６', '１２３-４５６', '\t123 456\n']) {
    assert.equal(normalizeDemoCode(raw), '123456');
  }
  assert.equal(normalizeDemoCode('1234567'), '123456');
  assert.equal(normalizeDemoCode(''), '');
});

test('non-digit mistakes remain invalid instead of silently becoming a valid code', () => {
  for (const raw of ['12a456', '12!456', '12。456', '123abc', '123456x', '１２３４５６!']) {
    assert.equal(/^\d{6}$/.test(normalizeDemoCode(raw)), false);
  }
});
