import { create } from 'zustand';
import type { Constraint } from '@/shared/types';

interface SharedCalendarState {
  /** 其他计划的固定忙时/固定日程（只读，参与求解与日历底色）。 */
  windows: Constraint[];
  setWindows: (windows: Constraint[]) => void;
}

export const useSharedCalendar = create<SharedCalendarState>((set) => ({
  windows: [],
  setWindows: (windows) => set({ windows }),
}));