import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { clampMessage, MESSAGE_MAX } from '@/lib/markdown';
import { cn } from '@/lib/utils';

export function ChatInput({ streaming, disabled, queued = [], onSend, onSendNow, onRemoveQueued, onInterrupt }: {
  streaming: boolean; disabled?: boolean; queued?: { id: string; text: string }[];
  onSend: (text: string) => void; onSendNow: (id: string) => void; onRemoveQueued: (id: string) => void; onInterrupt: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === '/' && !target.closest('input, textarea, select, [contenteditable]')) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = () => {
    const t = clampMessage(text.trim());
    if (!t || disabled) return;
    onSend(t);
    setText('');
  };

  return (
    <div className="border-t border-site-line bg-site-bg p-3">
      {queued.length > 0 && (
        <div className="mb-2 space-y-1" aria-label="排队中的消息">
          {queued.map((q) => (
            <div key={q.id} className="flex items-center gap-2 rounded-[var(--site-radius-card)] border border-site-line bg-site-surface-2 px-2 py-1 text-xs text-site-ink">
              <span className="shrink-0 text-site-ink-soft">排队</span>
              <span className="min-w-0 flex-1 truncate">{q.text}</span>
              <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-site-ink hover:bg-site-surface" onClick={() => onSendNow(q.id)}>插队</button>
              <button type="button" className="shrink-0 rounded px-1 py-0.5 text-site-ink-soft hover:text-site-danger" aria-label="删除排队消息" onClick={() => onRemoveQueued(q.id)}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="relative rounded-(--site-radius) border border-site-line bg-site-surface focus-within:border-site-ink">
        <Textarea
          ref={ref}
          value={text}
          rows={2}
          maxLength={MESSAGE_MAX}
          disabled={disabled}
          placeholder={streaming ? '生成中：Enter 加入排队，可点上方「插队」立即发送' : '说说你的安排，例如「周三晚兼职，数学英语别连着学」（/ 聚焦）'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          className="max-h-40 min-h-[52px] resize-none border-0 bg-transparent pr-12 shadow-none focus-visible:ring-0"
          aria-label="对话输入"
        />
        <div className="absolute bottom-2 right-2 flex items-center gap-2">
          <span className={cn('tabular text-xs', text.length > MESSAGE_MAX - 100 ? 'text-site-danger' : 'text-site-ink-soft')}>
            {text.length}/{MESSAGE_MAX}
          </span>
          {streaming ? (
            <>
              <Button size="icon" className="h-8 w-8" aria-label="加入排队" disabled={!text.trim() || disabled} onClick={submit}>
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="outline" className="h-8 w-8" aria-label="中断生成" onClick={onInterrupt}>
                <Square className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            <Button size="icon" className="h-8 w-8" aria-label="发送" disabled={!text.trim() || disabled} onClick={submit}>
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}