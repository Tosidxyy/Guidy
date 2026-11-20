import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../useUiStore';

describe('多选状态', () => {
  beforeEach(() => useUiStore.getState().select(null));

  it('toggleSelected 逐个追加与移除，不产生重复', () => {
    useUiStore.getState().select('a');
    useUiStore.getState().toggleSelected('b');
    expect(useUiStore.getState().selectedBlockIds).toEqual(['a', 'b']);
    useUiStore.getState().toggleSelected('a');
    expect(useUiStore.getState().selectedBlockIds).toEqual(['b']);
    useUiStore.getState().toggleSelected('b');
    expect(useUiStore.getState().selectedBlockIds).toEqual([]);
  });

  it('selectMany 去重并保持顺序', () => {
    useUiStore.getState().selectMany(['a', 'b', 'a', 'c']);
    expect(useUiStore.getState().selectedBlockIds).toEqual(['a', 'b', 'c']);
  });

  it('select 单块替换全部选择', () => {
    useUiStore.getState().selectMany(['a', 'b']);
    useUiStore.getState().select('c');
    expect(useUiStore.getState().selectedBlockIds).toEqual(['c']);
    useUiStore.getState().select(null);
    expect(useUiStore.getState().selectedBlockIds).toEqual([]);
  });
});
describe('resolveTheme（宣传主页跳转主题一致）', () => {
  it('?theme= 优先于已保存与系统偏好', async () => {
    const { resolveTheme } = await import('../useUiStore');
    expect(resolveTheme('?theme=dark', 'light', false)).toBe('dark');
    expect(resolveTheme('?theme=light', 'dark', true)).toBe('light');
  });
  it('无参数时已保存优先于系统', async () => {
    const { resolveTheme } = await import('../useUiStore');
    expect(resolveTheme('', 'dark', false)).toBe('dark');
    expect(resolveTheme('', null, true)).toBe('dark');
    expect(resolveTheme('', null, false)).toBe('light');
    expect(resolveTheme('?theme=bogus', 'light', true)).toBe('light');
  });
});
