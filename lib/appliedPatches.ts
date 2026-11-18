import type { PatchArtifact } from '@/shared/schemas';
import { canonical } from '@/lib/restoreChat';

const KEY = 'guidy.applied-patches.v1';

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type Book = Record<string, string[]>;

// 同一份 patch 的标识：只取语义字段，避免重新解析后键序不同导致误判。
export function patchSignature(patch: PatchArtifact): string {
  return canonical({ summary: patch.summary, ops: patch.ops });
}

/**
 * 已应用的 AI patch 记录（按对话）。刷新会从历史重建确认卡，
 * 这里记住“已经应用过”，避免再次弹出同一张可执行卡片。
 */
export function createAppliedPatches(storage: KeyValue | null) {
  function read(): Book {
    if (!storage) return {};
    try {
      const parsed = JSON.parse(storage.getItem(KEY) ?? '{}') as Book;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function write(book: Book): void {
    if (!storage) return;
    try {
      storage.setItem(KEY, JSON.stringify(book));
    } catch {
      // 存不下只影响刷新后是否重复提示，不影响应用结果。
    }
  }

  return {
    isApplied(conversationId: string | null, patch: PatchArtifact): boolean {
      if (!conversationId) return false;
      return (read()[conversationId] ?? []).includes(patchSignature(patch));
    },
    mark(conversationId: string | null, patch: PatchArtifact): void {
      if (!conversationId) return;
      const signature = patchSignature(patch);
      const book = read();
      const list = book[conversationId] ?? [];
      if (list.includes(signature)) return;
      book[conversationId] = [...list, signature].slice(-40);
      write(book);
    },
  };
}

const browserStorage = (() => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
})();

export const appliedPatches = createAppliedPatches(browserStorage);