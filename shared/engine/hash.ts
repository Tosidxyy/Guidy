import { ENGINE_VERSION } from '../constants';
import type { Block } from '../types';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function resultHash(blocks: Block[]): Promise<string> {
  const normalized = [...blocks]
    .sort((a, b) => a.start_utc.localeCompare(b.start_utc) || a.title.localeCompare(b.title))
    .map((b) => ({
      task_key: b.task_key ?? null,
      title: b.title,
      category: b.category,
      start_utc: b.start_utc,
      end_utc: b.end_utc,
      pinned: b.pinned,
    }));
  const payload = stableStringify({ engine_version: ENGINE_VERSION, blocks: normalized });
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)).then((buf) =>
    Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''),
  );
}