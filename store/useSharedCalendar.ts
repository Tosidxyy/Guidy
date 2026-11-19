import { create } from 'zustand';
import type { Block, Constraint } from '@/shared/types';

interface SharedCalendarState {
  /** 其他计划的固定忙时/固定日程（只读，参与求解与日历底色）。 */
  windows: Constraint[];
  /** 访客级公共块（忙时/固定日程），日历上始终可见。 */
  busyBlocks: Block[];
  busyIds: Set<string>;
  setWindows: (windows: Constraint[]) => void;
  setBusyBlocks: (blocks: Block[]) => void;
}

export const useSharedCalendar = create<SharedCalendarState>((set) => ({
  windows: [],
  busyBlocks: [],
  busyIds: new Set<string>(),
  setWindows: (windows) => set({ windows }),
  // 存量旧数据可能带 pinned/origin:'fixed'；固定日程现在就是普通块，显示与编辑模型统一归一化。
  setBusyBlocks: (blocks) => {
    const normalized = blocks.map((b) => ({ ...b, pinned: false, origin: 'manual' as const }));
    set({ busyBlocks: normalized, busyIds: new Set(normalized.map((b) => b.id)) });
  },
}));