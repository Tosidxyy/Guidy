const APP_URL = 'https://guidy-app-oxg3oo3dpdz.qoder.zone';
const THEME_KEY = 'guidy.theme';

function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* ignore */ }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let theme = initialTheme();
const toggle = document.getElementById('themeToggle');
const favicon = document.getElementById('favicon');

function applyTheme() {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  const src = theme === 'dark' ? 'assets/symbol-white.png' : 'assets/symbol-black.png';
  document.querySelectorAll('[data-brand]').forEach((img) => { img.src = src; });
  if (favicon) favicon.href = src;
  toggle.setAttribute('aria-label', theme === 'dark' ? '切换到浅色' : '切换到深色');
  document.querySelectorAll('[data-app-link]').forEach((a) => { a.href = `${APP_URL}/?theme=${theme}`; });
}
applyTheme();

toggle.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  applyTheme();
});

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const reveals = document.querySelectorAll('.reveal');
if (reduce || !('IntersectionObserver' in window)) {
  reveals.forEach((el) => el.classList.add('in'));
} else {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { threshold: 0.15 });
  reveals.forEach((el) => io.observe(el));
}

const video = document.getElementById('promo');
const fallback = document.getElementById('videoFallback');
const showFallback = () => { video.hidden = true; fallback.hidden = false; };
video.addEventListener('error', showFallback);
video.querySelector('source')?.addEventListener('error', showFallback);
fetch('assets/promo.mp4', { method: 'HEAD' }).then((r) => { if (!r.ok) showFallback(); }).catch(showFallback);