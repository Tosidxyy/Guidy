import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

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

export function EmptyCalendar({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-4', className)} aria-hidden="true">
      <span className="block h-24 w-24 bg-[var(--site-muted)] opacity-40 dark:bg-site-ink dark:opacity-60" style={MASK} />
      <span className="h-px w-40 bg-site-line dark:bg-site-ink/15" />
    </div>
  );
}