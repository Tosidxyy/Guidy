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
  setBusyBlocks: (blocks) => set({ busyBlocks: blocks, busyIds: new Set(blocks.map((b) => b.id)) }),
}));