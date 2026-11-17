const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{32}$/;

export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function normalizeCode(input: string): string {
  return input.replace(/[-\s]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function formatCode(raw: string): string {
  return (raw.match(/.{4}/g) ?? []).join('-');
}

export function isValidCode(normalized: string): boolean {
  return CODE_RE.test(normalized);
}