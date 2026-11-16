import { memo } from 'react';
import { Lock, Pin } from 'lucide-react';
import type { Block } from '@/shared/types';
import { CATEGORY_MAP } from '@/shared/constants';
import { minToHHmm } from '@/shared/engine';
import { cn } from '@/lib/utils';

export type BlockVisualState = 'normal' | 'selected' | 'invalid' | 'soft' | 'ghost-added' | 'ghost-removed' | 'ghost-moved' | 'dimmed';

interface Props {
  block: Block;
  startMin: number;
  endMin: number;
  top: number;
  height: number;
  leftPct: number;
  widthPct: number;
  visual: BlockVisualState;
  compact: boolean;
  onPointerDown?: (e: React.PointerEvent, block: Block) => void;
  onResizeDown?: (e: React.PointerEvent, block: Block) => void;
  onOpen?: (block: Block) => void;
}

export const BlockCard = memo(function BlockCard({
  block, startMin, endMin, top, height, leftPct, widthPct, visual, compact,
  onPointerDown, onResizeDown, onOpen,
}: Props) {
  const cat = CATEGORY_MAP[block.category] ?? CATEGORY_MAP.other;
  const ghost = visual.startsWith('ghost');
  const interactive = !ghost && visual !== 'dimmed';

  return (
    <div
      data-block-id={block.id}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={`${block.title} ${minToHHmm(startMin)} 到 ${minToHHmm(endMin)}`}
      className={cn(
        'group absolute select-none overflow-hidden rounded-md border text-left',
        'transition-shadow duration-150',
        interactive && 'cursor-grab active:cursor-grabbing touch-none',
        visual === 'normal' && 'border-transparent shadow-sm hover:shadow-md',
        visual === 'selected' && 'border-site-brand shadow-md ring-2 ring-site-brand/30',
        visual === 'invalid' && 'border-site-danger ring-2 ring-site-danger/40 animate-guidy-shake',
        visual === 'soft' && 'border-site-warning ring-2 ring-site-warning/30',
        visual === 'dimmed' && 'opacity-25 pointer-events-none',
        visual === 'ghost-added' && 'border-dashed border-site-success pointer-events-none',
        visual === 'ghost-removed' && 'border-dashed border-site-danger pointer-events-none opacity-60',
        visual === 'ghost-moved' && 'border-dashed border-site-warning pointer-events-none',
      )}
      style={{
        top, height: Math.max(height, 18), left: `${leftPct}%`, width: `calc(${widthPct}% - 4px)`,
        ['--cat' as string]: cat.color,
        background: ghost
          ? `color-mix(in srgb, ${cat.color} ${visual === 'ghost-added' ? 16 : 8}%, var(--site-surface))`
          : `color-mix(in srgb, ${cat.color} 13%, var(--site-surface))`,
        borderLeftWidth: 3,
        borderLeftColor: cat.color,
        zIndex: visual === 'selected' ? 20 : 10,
      }}
      onPointerDown={interactive ? (e) => onPointerDown?.(e, block) : undefined}
      onDoubleClick={interactive ? () => onOpen?.(block) : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter') onOpen?.(block); } : undefined}
    >
      <div className={cn('flex h-full flex-col px-1.5', compact ? 'justify-center py-0' : 'py-1')}>
        <div className="flex items-center gap-1 min-w-0">
          <span className="truncate text-xs font-semibold leading-tight" style={{ color: `color-mix(in srgb, ${cat.color} 70%, var(--site-fg))` }}>
            {block.title}
          </span>
          {block.pinned && <Pin className="h-3 w-3 shrink-0" style={{ color: cat.color }} aria-label="已钉住" />}
          {block.origin === 'fixed' && <Lock className="h-3 w-3 shrink-0 text-site-ink-soft" aria-label="固定" />}
          {visual === 'ghost-removed' && <span className="ml-auto text-[10px] text-site-danger">移除</span>}
          {visual === 'ghost-added' && <span className="ml-auto text-[10px] text-site-success">新增</span>}
        </div>
        {!compact && (
          <span className="tabular mt-0.5 text-[10px] leading-tight text-site-ink-soft">
            {minToHHmm(startMin)}–{minToHHmm(endMin)}
          </span>
        )}
      </div>
      {interactive && (
        <div
          data-resize-handle
          className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize touch-none"
          onPointerDown={(e) => { e.stopPropagation(); onResizeDown?.(e, block); }}
        >
          <div className="mx-auto mt-0.5 h-0.5 w-6 rounded-full opacity-0 transition-opacity duration-150 group-hover:opacity-40" style={{ background: cat.color }} />
        </div>
      )}
    </div>
  );
});