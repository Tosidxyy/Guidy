import { useEffect, useRef, useState } from 'react';

const GLIDE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const REVEAL_START = 100;
const SEG_STAGGER = 55;
const SEG_FADE = 300;
const WORD_START = 900;
const WORD_MS = 500;
const FLY_START = 1700;
const FLY_MS = 600;

const SYMBOL_MASK: React.CSSProperties = {
  maskImage: 'url(/brand/symbol-black.png)',
  maskSize: 'contain',
  maskRepeat: 'no-repeat',
  maskPosition: 'center',
  WebkitMaskImage: 'url(/brand/symbol-black.png)',
  WebkitMaskSize: 'contain',
  WebkitMaskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
};

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
/** 加密站点：相邻中点插值，段间重叠更大 → 显形边缘柔和无硬切面。 */
const STATIONS: [number, number, number, number][] = BASE_STATIONS.flatMap((s, i) => {
  if (i === BASE_STATIONS.length - 1) return [s];
  const n = BASE_STATIONS[i + 1];
  return [s, [(s[0] + n[0]) / 2, (s[1] + n[1]) / 2, (s[2] + n[2]) / 2, (s[3] + n[3]) / 2] as [number, number, number, number]];
});

/** 站点处垂直于行进方向的带状clip（沿路径重叠，保证柔和过渡）。 */
function bandPolygon(x: number, y: number, tx: number, ty: number): string {
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
  return `polygon(${pts.map(([a, b]) => `${a.toFixed(2)}% ${b.toFixed(2)}%`).join(', ')})`;
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
        {STATIONS.map(([x, y, tx, ty], i) => (
          <span
            key={i}
            data-seg={i}
            className="absolute inset-0 block"
            style={{ backgroundColor: 'var(--site-fg)', clipPath: bandPolygon(x, y, tx, ty), opacity: 0, ...SYMBOL_MASK }}
          />
        ))}
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