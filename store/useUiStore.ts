import { create } from 'zustand';

export type DrawerKind = 'constraints' | 'block' | 'settings' | 'tasks' | null;
export type ViewMode = 'week' | 'day';
export type MobileTab = 'overview' | 'calendar';

interface UiStore {
  theme: 'light' | 'dark';
  view: ViewMode;
  weekOffset: number;
  dayAnchor: string | null;
  visibleStart: number;
  visibleEnd: number;
  selectedBlockId: string | null;
  drawer: DrawerKind;
  editingBlockId: string | null;
  quickAdd: { day: string; minutes: number } | null;
  mobileTab: MobileTab;
  setTheme: (t: 'light' | 'dark') => void;
  setView: (v: ViewMode) => void;
  setWeekOffset: (n: number) => void;
  setDayAnchor: (d: string | null) => void;
  setVisibleRange: (start: number, end: number) => void;
  select: (id: string | null) => void;
  openDrawer: (d: DrawerKind, blockId?: string | null) => void;
  closeDrawer: () => void;
  setQuickAdd: (q: { day: string; minutes: number } | null) => void;
  setMobileTab: (t: MobileTab) => void;
}

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('guidy.theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export const useUiStore = create<UiStore>((set) => ({
  theme: initialTheme(),
  view: 'week',
  weekOffset: 0,
  dayAnchor: null,
  visibleStart: 360,
  visibleEnd: 1440,
  selectedBlockId: null,
  drawer: null,
  editingBlockId: null,
  quickAdd: null,
  mobileTab: 'calendar',
  setTheme: (t) => {
    try {
      localStorage.setItem('guidy.theme', t);
    } catch {
      /* ignore */
    }
    set({ theme: t });
  },
  setView: (v) => set({ view: v }),
  setWeekOffset: (n) => set({ weekOffset: n }),
  setDayAnchor: (d) => set({ dayAnchor: d }),
  setVisibleRange: (start, end) => set({ visibleStart: start, visibleEnd: end }),
  select: (id) => set({ selectedBlockId: id }),
  openDrawer: (d, blockId = null) => set({ drawer: d, editingBlockId: blockId }),
  closeDrawer: () => set({ drawer: null, editingBlockId: null, quickAdd: null }),
  setQuickAdd: (q) => set({ quickAdd: q }),
  setMobileTab: (t) => set({ mobileTab: t }),
}));