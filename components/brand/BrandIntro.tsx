import { useEffect, useRef, useState } from 'react';
import { LogoMark } from './Logo';

const GLIDE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const REVEAL_MS = 900;
const WORD_MS = 300;
const HOLD_MS = 300;
const FLY_MS = 600;

const REVEAL_MASK: React.CSSProperties = {
  maskImage: 'linear-gradient(to top right, #000 40%, transparent 60%)',
  maskSize: '300% 300%',
  maskRepeat: 'no-repeat',
  maskPosition: '100% 100%',
  WebkitMaskImage: 'linear-gradient(to top right, #000 40%, transparent 60%)',
  WebkitMaskSize: '300% 300%',
  WebkitMaskRepeat: 'no-repeat',
  WebkitMaskPosition: '100% 100%',
};

/**
 * 开屏品牌动画：巨大符号沿箭头尾→尖扫显 → 字标淡入 → FLIP 飞回 TopBar 静态位置。
 * 收位末帧与静态 logo 逐像素对齐：WAAPI fill forwards 结束后 double-rAF 同帧卸载。
 */
export function BrandIntro({ onDone, onUnblur }: { onDone: () => void; onUnblur: () => void }) {
  const markRef = useRef<HTMLSpanElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef(false);
  const cbRef = useRef({ onDone, onUnblur });
  cbRef.current = { onDone, onUnblur };
  const [size] = useState(() => Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.52));

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
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      timers.forEach(clearTimeout);
      anims.forEach((a) => a.finish());
      cbRef.current.onUnblur();
      cbRef.current.onDone();
    };

    timers.push(window.setTimeout(() => {
      anims.push(word.animate(
        [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: WORD_MS, easing: GLIDE, fill: 'forwards' },
      ));
    }, REVEAL_MS));
    timers.push(window.setTimeout(() => {
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
    }, REVEAL_MS + WORD_MS + HOLD_MS));
    timers.push(window.setTimeout(finish, REVEAL_MS + WORD_MS + HOLD_MS + FLY_MS + 150));

    const skip = () => finish();
    window.addEventListener('pointerdown', skip);
    window.addEventListener('keydown', skip);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', skip);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6" aria-hidden="true">
      <span ref={markRef} className="guidy-intro-reveal block" style={{ width: size, height: size, transformOrigin: 'top left', ...REVEAL_MASK }}>
        <LogoMark size={size} />
      </span>
      <span
        ref={wordRef}
        className="font-display font-bold tracking-[-0.02em] text-site-ink"
        style={{ fontSize: 'clamp(28px, 6vmin, 48px)', transformOrigin: 'top left', opacity: 0 }}
      >
        Guidy
      </span>
    </div>
  );
}