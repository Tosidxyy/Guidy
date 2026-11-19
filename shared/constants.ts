export const ENGINE_VERSION = 1 as const;

export const CATEGORIES = [
  { key: 'study', label: '学习', color: '#0f1419', icon: 'book-open' },
  { key: 'fitness', label: '健身', color: '#292f33', icon: 'dumbbell' },
  { key: 'reading', label: '阅读', color: '#43494d', icon: 'library' },
  { key: 'work', label: '工作', color: '#5c6367', icon: 'briefcase' },
  { key: 'life', label: '生活', color: '#757c81', icon: 'home' },
  { key: 'creative', label: '创造', color: '#8e959a', icon: 'palette' },
  { key: 'rest', label: '休息', color: '#a7aeb3', icon: 'moon' },
  { key: 'other', label: '其他', color: '#c0c7cb', icon: 'shapes' },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]['key'];

export const CATEGORY_MAP: Record<string, (typeof CATEGORIES)[number]> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c]),
);

export const PERIOD_BOUNDS: Record<string, [number, number]> = {
  morning: [360, 720],
  afternoon: [720, 1080],
  evening: [1080, 1320],
  night: [1320, 1440],
};

export const PERIOD_LABEL: Record<string, string> = {
  morning: '早晨',
  afternoon: '下午',
  evening: '傍晚',
  night: '夜间',
};

export const DEFAULT_ACTIVE: [number, number] = [420, 1380];
export const MIN_FRAGMENT_MIN = 25;
export const SNAP_MIN = 15;
export const DEFAULT_MUTEX_GAP = 15;

export const LIMITS = {
  messageChars: 2000,
  titleChars: 60,
  descChars: 500,
  notesChars: 500,
  tagsMax: 3,
  tagChars: 12,
  taskDefsMax: 30,
  // 块数不设上限：日历是全局的，容量由服务端与前端渲染自然约束
  blocksMax: Number.MAX_SAFE_INTEGER,
  constraintsMax: 40,
  undoDepth: 30,
};

export const QUOTAS = { chatTurnsPerDay: 60, publishesPerDay: 3, recoveryAttemptsPerDay: 10, plansPerVisitor: 20 };

export const PRIORITY_WEIGHT: Record<string, number> = { high: 0, mid: 1, low: 2 };