import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { Sparkles } from 'lucide-react';
import type { ChatMessage } from '@/store/useChatStore';
import { sanitizeSchema } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { StreamingCursor } from './StreamingCursor';

export function MessageBubble({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  if (message.kind === 'constraint_set' || message.kind === 'patch') {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-[var(--site-dawn-line)]/30 bg-[var(--site-dawn-soft)] px-3 py-2 text-xs text-site-ink">
        <Sparkles className="h-3.5 w-3.5 text-[var(--site-dawn-line)]" />
        {message.kind === 'constraint_set' ? '已生成约束方案，请在下方确认卡核对' : '已生成调整建议'}
      </div>
    );
  }
  if (message.role === 'system' || message.kind === 'status' || message.kind === 'error') {
    return <p className="px-1 text-center text-[11px] text-site-ink-soft">{message.content}</p>;
  }
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
          isUser ? 'bg-site-brand text-white' : 'border border-site-line bg-site-surface text-site-ink',
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <div className="guidy-prose break-words">
            <ReactMarkdown rehypePlugins={[[rehypeSanitize, sanitizeSchema]]} skipHtml>
              {message.content}
            </ReactMarkdown>
            {streaming && <StreamingCursor />}
          </div>
        )}
      </div>
    </div>
  );
}