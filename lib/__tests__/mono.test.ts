import { beforeEach, describe, expect, it, vi } from 'vitest';
import { categoryColor } from '@/lib/describe';
import { loadPrefs, DEFAULT_PREFS } from '@/lib/prefs';

// vitest node 环境无 DOM localStorage：注入内存实现，行为与浏览器一致（仅供本文件测试）
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
  removeItem: (k: string) => { memory.delete(k); },
  clear: () => { memory.clear(); },
  key: (i: number) => Array.from(memory.keys())[i] ?? null,
  get length() { return memory.size; },
});
beforeEach(() => memory.clear());

describe('monochrome tokens', () => {
  it('categoryColor 返回主题灰阶 var', () => {
    expect(categoryColor('study')).toBe('var(--site-cat-study)');
    expect(categoryColor('nope')).toBe('var(--site-cat-other)');
  });
  it('prefs v1 迁移：半径重置默认，其余保留', () => {
    localStorage.setItem('guidy.prefs.v1', JSON.stringify({ radius: 4, space: 1.1, type: 0.95, motion: 0 }));
    const p = loadPrefs();
    expect(p.radius).toBe(DEFAULT_PREFS.radius);
    expect(p.space).toBe(1.1);
    expect(p.type).toBe(0.95);
    expect(p.motion).toBe(0);
    expect(localStorage.getItem('guidy.prefs.v2')).toBeTruthy();
  });
  it('prefs v2 优先', () => {
    localStorage.setItem('guidy.prefs.v2', JSON.stringify({ radius: 8, space: 1, type: 1, motion: 1 }));
    expect(loadPrefs().radius).toBe(8);
  });
});