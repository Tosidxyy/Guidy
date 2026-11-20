import { create } from 'zustand';

export type DrawerKind = 'constraints' | 'block' | 'settings' | 'plans' | 'feedback' | null;
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

export function resolveTheme(search: string, saved: string | null, systemDark: boolean): 'light' | 'dark' {
  const param = new URLSearchParams(search).get('theme');
  if (param === 'light' || param === 'dark') return param;
  if (saved === 'light' || saved === 'dark') return saved;
  return systemDark ? 'dark' : 'light';
}

function initialTheme(): 'light' | 'dark' {
  try {
    // 宣传主页跳转会带 ?theme=，落地时与应用主题保持一致并持久化。
    const param = new URLSearchParams(window.location.search).get('theme');
    if (param === 'light' || param === 'dark') localStorage.setItem('guidy.theme', param);
    return resolveTheme(window.location.search, localStorage.getItem('guidy.theme'), window.matchMedia('(prefers-color-scheme: dark)').matches);
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