import { create } from 'zustand';

export type DrawerKind = 'constraints' | 'block' | 'settings' | 'tasks' | 'plans' | null;
export type ViewMode = 'week' | 'day';
export type MobileTab = 'chat' | 'calendar';

interface UiStore {
  theme: 'light' | 'dark';
  view: ViewMode;
  /** 当前查看的日期（YYYY-MM-DD）；周视图取所在周的周一到周日。 */
  dayAnchor: string | null;
  visibleStart: number;
  visibleEnd: number;
  selectedBlockIds: string[];
  drawer: DrawerKind;
  editingBlockId: string | null;
  quickAdd: { day: string; minutes: number } | null;
  mobileTab: MobileTab;
  setTheme: (t: 'light' | 'dark') => void;
  setView: (v: ViewMode) => void;
  setDayAnchor: (d: string | null) => void;
  setVisibleRange: (start: number, end: number) => void;
  select: (id: string | null) => void;
  selectMany: (ids: string[]) => void;
  toggleSelected: (id: string) => void;
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
  dayAnchor: null,
  visibleStart: 360,
  visibleEnd: 1440,
  selectedBlockIds: [],
  drawer: null,
  editingBlockId: null,
  quickAdd: null,
  mobileTab: 'chat',
  setTheme: (t) => {
    try {
      localStorage.setItem('guidy.theme', t);
    } catch {
      /* ignore */
    }
    set({ theme: t });
  },
  setView: (v) => set({ view: v }),
  setDayAnchor: (d) => set({ dayAnchor: d }),
  setVisibleRange: (start, end) => set({ visibleStart: start, visibleEnd: end }),
  select: (id) => set({ selectedBlockIds: id ? [id] : [] }),
  selectMany: (ids) => set({ selectedBlockIds: [...new Set(ids)] }),
  toggleSelected: (id) => set((s) => ({
    selectedBlockIds: s.selectedBlockIds.includes(id)
      ? s.selectedBlockIds.filter((x) => x !== id)
      : [...s.selectedBlockIds, id],
  })),
  openDrawer: (d, blockId = null) => set({ drawer: d, editingBlockId: blockId }),
  closeDrawer: () => set({ drawer: null, editingBlockId: null, quickAdd: null }),
  setQuickAdd: (q) => set({ quickAdd: q }),
  setMobileTab: (t) => set({ mobileTab: t }),
}));