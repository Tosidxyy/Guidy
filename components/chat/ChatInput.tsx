import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { clampMessage, MESSAGE_MAX } from '@/lib/markdown';
import { cn } from '@/lib/utils';

export function ChatInput({ streaming, disabled, onSend, onInterrupt }: {
  streaming: boolean; disabled?: boolean; onSend: (text: string) => void; onInterrupt: () => void;
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
    if (!t || streaming || disabled) return;
    onSend(t);
    setText('');
  };

  return (
    <div className="border-t border-site-line bg-site-bg p-3">
      <div className="relative rounded-xl border border-site-line bg-site-surface focus-within:border-site-brand">
        <Textarea
          ref={ref}
          value={text}
          rows={2}
          maxLength={MESSAGE_MAX}
          disabled={disabled}
          placeholder={streaming ? 'Guidy 正在生成…' : '说说你的安排，例如「周三晚兼职，数学英语别连着学」（/ 聚焦）'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          className="max-h-40 min-h-[52px] resize-none border-0 bg-transparent pr-12 shadow-none focus-visible:ring-0"
          aria-label="对话输入"
        />
        <div className="absolute bottom-2 right-2 flex items-center gap-2">
          <span className={cn('tabular text-[10px]', text.length > MESSAGE_MAX - 100 ? 'text-site-danger' : 'text-site-ink-soft')}>
            {text.length}/{MESSAGE_MAX}
          </span>
          {streaming ? (
            <Button size="icon" variant="outline" className="h-8 w-8" aria-label="中断生成" onClick={onInterrupt}>
              <Square className="h-3.5 w-3.5" />
            </Button>
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