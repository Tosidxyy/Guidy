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
  document.querySelectorAll('[data-app-link]').forEach((a) => { a.href = APP_URL + '/?theme=' + theme; });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0c0c0d' : '#fbfaf8';
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
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  reveals.forEach((el) => io.observe(el));
}

const header = document.getElementById('top');
const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

/* 视频：点击封面才加载；文件缺失时整个模块隐藏。 */
const shell = document.getElementById('filmShell');
const video = document.getElementById('promo');
const playBtn = document.getElementById('filmPlay');
const filmSection = document.getElementById('film');
fetch('assets/promo.mp4', { method: 'HEAD' }).then((r) => {
  if (!r.ok) filmSection.hidden = true;
}).catch(() => { filmSection.hidden = true; });
playBtn.addEventListener('click', () => {
  shell.classList.add('is-playing');
  video.preload = 'auto';
  video.play().catch(() => { shell.classList.remove('is-playing'); });
});
video.addEventListener('error', () => { filmSection.hidden = true; });

/* 功能 vignette：并行 review */
const vgP = document.getElementById('vgParallel');
const pA = vgP.querySelector('.vg-a');
const pB = vgP.querySelector('.vg-b');
const pM = vgP.querySelector('.vg-merged');
const pNote = document.getElementById('parallelNote');
const PARALLEL = {
  ask: { a: ['30%', '34%'], b: ['44%', '34%'], merged: false, note: '同一小时里有两件事，等你决定。' },
  merge: { a: null, b: null, merged: true, note: '合成一块：组会 + 写论文，两件事的备注都留着。' },
  move: { a: ['14%', '34%'], b: ['62%', '34%'], merged: false, note: '写论文挪去空档，两件事都保住。' },
};
function setParallel(key) {
  const s = PARALLEL[key];
  vgP.querySelectorAll('[data-parallel]').forEach((b) => b.classList.toggle('is-on', b.dataset.parallel === key));
  pA.hidden = !s.a; pB.hidden = !s.b; pM.hidden = !s.merged;
  if (s.a) { pA.style.setProperty('--t', s.a[0]); pA.style.setProperty('--h', s.a[1]); }
  if (s.b) { pB.style.setProperty('--t', s.b[0]); pB.style.setProperty('--h', s.b[1]); }
  pNote.textContent = s.note;
}
vgP.querySelectorAll('[data-parallel]').forEach((b) => b.addEventListener('click', () => setParallel(b.dataset.parallel)));

/* 功能 vignette：一句话重排 + 撤销 */
const patchBlock = document.getElementById('patchBlock');
const patchExtra = document.getElementById('patchExtra');
const patchSay = document.getElementById('patchSay');
const patchUndo = document.getElementById('patchUndo');
const patchNote = document.getElementById('patchNote');
function setPatch(on) {
  patchExtra.hidden = !on;
  patchBlock.style.setProperty('--t', on ? '78%' : '52%');
  patchBlock.style.setProperty('--h', on ? '22%' : '24%');
  patchSay.hidden = on;
  patchUndo.hidden = !on;
  patchNote.textContent = on
    ? '加班占了原时段：报告挪到当晚更晚的空档，其余不动。'
    : '周四晚上原本留给报告。';
}
patchSay.addEventListener('click', () => setPatch(true));
patchUndo.addEventListener('click', () => setPatch(false));

/* 功能 vignette：排不下的取舍 */
const tradeFlex = document.getElementById('tradeFlex');
const tradeWhen = document.getElementById('tradeWhen');
const tradeNote = document.getElementById('tradeNote');
function setTrade(key) {
  document.querySelectorAll('[data-trade]').forEach((b) => b.classList.toggle('is-on', b.dataset.trade === key));
  const defer = key === 'defer';
  tradeFlex.classList.toggle('is-deferred', defer);
  tradeWhen.textContent = defer ? '建议下周' : '本周 · 排不下';
  tradeNote.textContent = defer
    ? '本周剩 6 小时，两件急事占 5 小时半。'
    : '硬塞会挤掉睡眠：它建议把读书拆成每天 20 分钟，或顺延到下周。';
}
document.querySelectorAll('[data-trade]').forEach((b) => b.addEventListener('click', () => setTrade(b.dataset.trade)));
setTrade('defer');