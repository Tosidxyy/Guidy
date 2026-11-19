import type { CSSProperties } from 'react';

const MASK: CSSProperties = {
  maskImage: 'url(/brand/symbol-black.png)',
  maskSize: 'contain',
  maskRepeat: 'no-repeat',
  maskPosition: 'center',
  WebkitMaskImage: 'url(/brand/symbol-black.png)',
  WebkitMaskSize: 'contain',
  WebkitMaskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
};

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      data-intro-target="mark"
      className="block shrink-0"
      style={{ width: size, height: size, backgroundColor: 'var(--site-fg)', ...MASK }}
    />
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 select-none">
      <LogoMark />
      {!compact && (
        <span data-intro-target="word" className="font-display text-lg font-bold tracking-[-0.02em] text-site-ink">
          Guidy
        </span>
      )}
    </span>
  );
}