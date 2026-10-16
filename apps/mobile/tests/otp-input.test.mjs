import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOtpCode } from '../src/auth/otp-input.ts';

test('formatted and full-width pasted OTP digits become the same six digit input', () => {
  for (const raw of ['123 456', '123-456', '１２３４５６', '１２３-４５６', '\t123 456\n']) {
    assert.equal(normalizeOtpCode(raw), '123456');
  }
  assert.equal(normalizeOtpCode('1234567'), '123456');
  assert.equal(normalizeOtpCode(''), '');
});

test('non-digit mistakes remain invalid instead of silently becoming a valid code', () => {
  for (const raw of ['12a456', '12!456', '12。456', '123abc', '123456x', '１２３４５６!']) {
    assert.equal(/^\d{6}$/.test(normalizeOtpCode(raw)), false);
  }
});
