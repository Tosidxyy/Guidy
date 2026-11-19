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
      <span className="block h-24 w-24 opacity-40" style={{ backgroundColor: 'var(--site-muted)', ...MASK }} />
      <span className="h-px w-40 bg-site-line" />
    </div>
  );
}