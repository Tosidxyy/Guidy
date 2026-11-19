import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '@/store/useUiStore';

const GLIDE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const REVEAL_START = 100;
const SEG_STAGGER = 22;
const SEG_FADE = 260;
const WORD_START = 900;
const WORD_MS = 500;
const FLY_START = 1700;
const FLY_MS = 600;

/** 主题对应的透明底符号贴图（免 mask，合成器友好）；主题取自 store，首渲染即正确。 */
function symbolTexture(dark: boolean): string {
  return dark ? 'url(/brand/symbol-white.png)' : 'url(/brand/symbol-black.png)';
}

/** 道路中心线站点（图标盒百分比）+ 行进方向；分段clip沿路径排序：尾→左弯→右上→尖。 */
const BASE_STATIONS: [number, number, number, number][] = [
  [55, 76, -0.85, -0.5],
  [39, 68, -0.9, -0.45],
  [25, 59, 0.2, -0.98],
  [30, 51, 0.9, -0.45],
  [45, 47, 0.95, -0.3],
  [59, 39, 0.6, -0.8],
  [64, 31, 0.7, -0.7],
  [74, 22, 0.8, -0.6],
  [80, 18, 0.8, -0.6],
];
/** 加密站点：每相邻站插 4 个中点 → 41 段，前沿连续推进无跳格。 */
const STATIONS: [number, number, number, number][] = BASE_STATIONS.flatMap((s, i) => {
  if (i === BASE_STATIONS.length - 1) return [s];
  const n = BASE_STATIONS[i + 1];
  const out: [number, number, number, number][] = [s];
  for (let k = 1; k <= 4; k++) {
    const t = k / 5;
    out.push([s[0] + (n[0] - s[0]) * t, s[1] + (n[1] - s[1]) * t, s[2] + (n[2] - s[2]) * t, s[3] + (n[3] - s[3]) * t]);
  }
  return out;
});

/** 站点处垂直于行进方向的带状clip；返回子层bbox（图标%）与子层局部clip，子层纹理只覆盖带区。 */
function band(x: number, y: number, tx: number, ty: number) {
  const len = Math.hypot(tx, ty);
  const ux = tx / len;
  const uy = ty / len;
  const px = -uy;
  const py = ux;
  const half = 38;
  const thick = 12;
  const pts = [
    [x - px * half - ux * thick, y - py * half - uy * thick],
    [x + px * half - ux * thick, y + py * half - uy * thick],
    [x + px * half + ux * thick, y + py * half + uy * thick],
    [x - px * half + ux * thick, y - py * half + uy * thick],
  ];
  const left = Math.min(...pts.map((p) => p[0]));
  const top = Math.min(...pts.map((p) => p[1]));
  const w = Math.max(...pts.map((p) => p[0])) - left;
  const h = Math.max(...pts.map((p) => p[1])) - top;
  const poly = `polygon(${pts.map(([a, b]) => `${(((a - left) / w) * 100).toFixed(2)}% ${(((b - top) / h) * 100).toFixed(2)}%`).join(', ')})`;
  return { poly, left, top, w, h };
}

/**
 * 开屏品牌动画（分镜 0–2.3s）：强虚化背景 → 符号沿道路尾→尖逐段柔显 →
 * Guidy 字标上浮淡入 → 停留 → 图标/字标 FLIP 飞回左上角静态位（末帧逐像素对齐后同帧交接）。
 * 显形仅用静态 clip-path 分段 + WAAPI opacity（合成器属性，规避主线程动画被节流的环境）。
 */
export function BrandIntro({ onDone, onUnblur }: { onDone: () => void; onUnblur: () => void }) {
  const markRef = useRef<HTMLSpanElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef(false);
  const flyStartedRef = useRef(false);
  const cbRef = useRef({ onDone, onUnblur });
  cbRef.current = { onDone, onUnblur };
  const [size] = useState(() => Math.min(250, Math.round(window.innerWidth * 0.5)));
  const theme = useUiStore((s) => s.theme);
  const tex = symbolTexture(theme === 'dark');

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cbRef.current.onDone();
      return;
    }
    const mark = markRef.current;
    const word = wordRef.current;
    if (!mark || !word) {
      cbRef.current.onDone();
      return;
    }
    const anims: Animation[] = [];
    const timers: number[] = [];
    const segs = [...mark.querySelectorAll<HTMLElement>('[data-seg]')];

    const startFly = () => {
      if (flyStartedRef.current || doneRef.current) return;
      flyStartedRef.current = true;
      cbRef.current.onUnblur();
      const fly = (el: HTMLElement, selector: string) => {
        const target = document.querySelector(selector);
        if (!target) return;
        const t = target.getBoundingClientRect();
        const c = el.getBoundingClientRect();
        if (t.width < 2 || c.width < 2) {
          anims.push(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLY_MS, easing: GLIDE, fill: 'forwards' }));
          return;
        }
        const scale = t.width / c.width;
        anims.push(el.animate(
          [{ transform: 'translate(0, 0) scale(1)' }, { transform: `translate(${t.left - c.left}px, ${t.top - c.top}px) scale(${scale})` }],
          { duration: FLY_MS, easing: GLIDE, fill: 'forwards' },
        ));
      };
      fly(mark, '[data-intro-target="mark"]');
      fly(word, '[data-intro-target="word"]');
      timers.push(window.setTimeout(finish, FLY_MS + 20));
    };
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      timers.forEach(clearTimeout);
      anims.forEach((a) => a.finish());
      cbRef.current.onUnblur();
      cbRef.current.onDone();
    };

    segs.forEach((seg, i) => {
      anims.push(seg.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: SEG_FADE, delay: REVEAL_START + i * SEG_STAGGER, easing: 'ease-out', fill: 'forwards' },
      ));
    });
    timers.push(window.setTimeout(() => {
      anims.push(word.animate(
        [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: WORD_MS, easing: GLIDE, fill: 'forwards' },
      ));
    }, WORD_START));
    timers.push(window.setTimeout(startFly, FLY_START));
    timers.push(window.setTimeout(finish, FLY_START + FLY_MS + 150));

    const skip = () => {
      if (doneRef.current || flyStartedRef.current) return;
      timers.forEach(clearTimeout);
      anims.forEach((a) => a.finish());
      segs.forEach((s) => { s.style.opacity = '1'; });
      word.style.opacity = '1';
      word.style.transform = 'translateY(0)';
      startFly();
    };
    window.addEventListener('pointerdown', skip);
    window.addEventListener('keydown', skip);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', skip);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5">
      <span ref={markRef} aria-hidden="true" className="relative block" style={{ width: size, height: size, transformOrigin: 'top left' }}>
        {STATIONS.map(([x, y, tx, ty], i) => {
          const b = band(x, y, tx, ty);
          return (
            <span
              key={i}
              data-seg={i}
              className="absolute block"
              style={{
                left: `${b.left}%`,
                top: `${b.top}%`,
                width: `${b.w}%`,
                height: `${b.h}%`,
                backgroundImage: tex,
                backgroundSize: `${size}px ${size}px`,
                backgroundPosition: `${(-b.left / 100) * size}px ${(-b.top / 100) * size}px`,
                backgroundRepeat: 'no-repeat',
                clipPath: b.poly,
                opacity: 0,
                willChange: 'opacity',
              }}
            />
          );
        })}
      </span>
      <span
        ref={wordRef}
        aria-hidden="true"
        className="font-display font-bold tracking-[-0.02em] text-site-ink"
        style={{ fontSize: 18, transformOrigin: 'top left', opacity: 0 }}
      >
        Guidy
      </span>
    </div>
  );
}