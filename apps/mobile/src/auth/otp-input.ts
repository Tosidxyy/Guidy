// OTP input formatting only; this is not credential validation or authentication.
export function normalizeOtpCode(value: string): string {
  const formatted = value
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - '０'.charCodeAt(0)))
    .replace(/[\s-]/g, '');
  // Retain invalid suffixes so "123456x" cannot silently turn into a valid code.
  return /^\d*$/.test(formatted) ? formatted.slice(0, 6) : formatted.slice(0, 32);
}
