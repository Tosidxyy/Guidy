import { memo } from 'react';
import { Check, Lock, Pin } from 'lucide-react';
import type { Block } from '@/shared/types';
import { categoryColor } from '@/lib/describe';
import { minToHHmm } from '@/shared/engine';
import { cn } from '@/lib/utils';

export type BlockVisualState = 'normal' | 'selected' | 'invalid' | 'soft' | 'foreign' | 'ghost-added' | 'ghost-removed' | 'ghost-moved' | 'dimmed';

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
  planLabel?: string;
  /** 并行合并块：逐行显示标题（防文字重叠）。 */
  titleLines?: string[];
  onPointerDown?: (e: React.PointerEvent, block: Block) => void;
  onResizeDown?: (e: React.PointerEvent, block: Block) => void;
  onOpen?: (block: Block) => void;
  onClick?: () => void;
}

export const BlockCard = memo(function BlockCard({
  block, startMin, endMin, top, height, leftPct, widthPct, visual, compact,
  planLabel, titleLines, onPointerDown, onResizeDown, onOpen, onClick,
}: Props) {
  const ghost = visual.startsWith('ghost');
  const interactive = !ghost && visual !== 'dimmed';

  return (
    <div
      data-block-id={block.id}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={`${block.title} ${minToHHmm(startMin)} 到 ${minToHHmm(endMin)}${planLabel ? `，${planLabel}` : ''}`}
      className={cn(
        'group absolute select-none overflow-hidden rounded-md border text-left hover:[--cat-fill:18%]',
        'transition-shadow duration-150',
        interactive && !block.pinned && 'cursor-grab active:cursor-grabbing touch-none',
        interactive && block.pinned && 'cursor-default',
        visual === 'foreign' && 'border-dashed border-site-line opacity-45 hover:opacity-80',
        visual === 'normal' && 'border-transparent shadow-sm hover:shadow-md',
        visual === 'selected' && 'border-site-ink shadow-md ring-2 ring-site-ink/30',
        visual === 'invalid' && 'border-site-danger ring-2 ring-site-danger/40 animate-guidy-shake',
        visual === 'soft' && 'border-site-warning ring-2 ring-site-warning/30',
        visual === 'dimmed' && 'opacity-25 pointer-events-none',
        visual === 'ghost-added' && 'border-dashed border-site-success pointer-events-none',
        visual === 'ghost-removed' && 'border-dashed border-site-danger pointer-events-none opacity-60',
        visual === 'ghost-moved' && 'border-dashed border-site-warning pointer-events-none',
        block.status === 'completed' && 'opacity-60',
        block.status === 'partial' && 'border-dashed border-site-warning',
      )}
      style={{
        top, height: Math.max(height, 18), left: `${leftPct}%`, width: `calc(${widthPct}% - 4px)`,
        ['--cat' as string]: categoryColor(block.category),
        background: ghost
          ? `color-mix(in srgb, var(--cat) ${visual === 'ghost-added' ? 16 : 8}%, var(--site-surface))`
          : `color-mix(in srgb, var(--cat) var(--cat-fill, 14%), var(--site-surface))`,
        borderLeftWidth: 3,
        borderLeftColor: 'var(--cat)',
        zIndex: visual === 'selected' ? 20 : visual === 'foreign' ? 5 : 10,
      }}
      onPointerDown={interactive ? (e) => onPointerDown?.(e, block) : undefined}
      onClick={interactive && visual === 'foreign' ? onClick : undefined}
      onDoubleClick={interactive && visual !== 'foreign' ? () => onOpen?.(block) : undefined}
      onKeyDown={interactive ? (e) => {
        if (e.key !== 'Enter') return;
        if (visual === 'foreign') onClick?.();
        else onOpen?.(block);
      } : undefined}
    >
      <div className={cn('flex h-full flex-col px-1.5', compact ? 'justify-center py-0' : 'py-1')}>
        <div className="flex items-center gap-1 min-w-0">
          {titleLines?.length ? (
            <span className="flex min-w-0 flex-col" style={{ color: 'var(--site-fg)' }}>
              {titleLines.map((line, i) => (
                <span key={i} className={i === 0 ? 'truncate text-xs font-semibold leading-tight' : 'truncate text-[10px] leading-tight opacity-90'}>
                  {i > 0 ? `+ ${line}` : line}
                </span>
              ))}
            </span>
          ) : (
          <span className={cn('truncate text-xs font-semibold leading-tight', block.status === 'completed' && 'line-through')} style={{ color: 'var(--site-fg)' }}>
            {block.title}
          </span>
          )}
          {block.pinned && <Pin className="h-3 w-3 shrink-0" style={{ color: 'var(--cat)' }} aria-label="已钉住" />}
          {block.status === 'completed' && <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--cat)' }} aria-label="已完成" />}
          {block.origin === 'fixed' && <Lock className="h-3 w-3 shrink-0 text-site-ink-soft" aria-label="固定" />}
          {planLabel && <span className="ml-auto max-w-[55%] truncate rounded bg-site-surface/85 px-1 text-[9px] leading-tight text-site-ink-soft">{planLabel}</span>}
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
          <div className="mx-auto mt-0.5 h-0.5 w-6 rounded-full opacity-0 transition-opacity duration-150 group-hover:opacity-40" style={{ background: 'var(--cat)' }} />
        </div>
      )}
    </div>
  );
});