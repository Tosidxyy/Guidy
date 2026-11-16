export interface GuidyPrefs {
  radius: number;
  space: number;
  type: number;
  motion: 0 | 1;
}

export const DEFAULT_PREFS: GuidyPrefs = { radius: 10, space: 1, type: 1, motion: 1 };

const KEY = 'guidy.prefs.v1';

export function loadPrefs(): GuidyPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<GuidyPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: GuidyPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function applyPrefs(prefs: GuidyPrefs): void {
  const root = document.documentElement;
  root.style.setProperty('--site-radius', `${prefs.radius}px`);
  root.style.setProperty('--site-space', String(prefs.space));
  root.style.setProperty('--site-type', String(prefs.type));
  root.style.setProperty('--site-motion', String(prefs.motion));
}