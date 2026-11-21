import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { ClipboardCheck } from 'lucide-react';
import type { ChatMessage } from '@/store/useChatStore';
import { sanitizeSchema } from '@/lib/markdown';
import { splitArtifactText } from '@/lib/artifactText';
import { cn } from '@/lib/utils';
import { StreamingCursor } from './StreamingCursor';

export function MessageBubble({ message, streaming, clarificationPending, onRetry }: { message: ChatMessage; streaming?: boolean; clarificationPending?: boolean; onRetry?: () => void }) {
  if (message.kind === 'constraint_set' || message.kind === 'patch' || message.kind === 'question_card') {
    const artifactLabel = message.kind === 'question_card'
      ? '已生成待确认的问题'
      : message.kind === 'patch'
        ? '已生成调整建议'
        : clarificationPending
          ? '已生成初版约束方案，请先回答问题'
          : '已生成约束方案，请在下方方案卡核对';
    return (
      <div className="flex items-center gap-1.5 rounded-[var(--site-radius-card)] border border-site-line bg-site-surface-2 px-3 py-2 text-xs text-site-ink">
        <ClipboardCheck className="h-3.5 w-3.5 text-site-ink-soft" />
        <div>
          {artifactLabel}
          {message.content && <p className="mt-1 text-site-ink-soft">{message.content}</p>}
        </div>
      </div>
    );
  }
  if (message.role === 'system' || message.kind === 'status' || message.kind === 'error') {
    return <p className="px-1 text-center text-xs text-site-ink-soft">{message.content}</p>;
  }
  const isUser = message.role === 'user';
  if (!isUser) {
    const { prose, artifactJson } = splitArtifactText(message.content);
    if (artifactJson !== null) {
      if (!streaming && !prose) return null;
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-[var(--site-radius-card)] border border-site-line bg-site-surface px-3.5 py-2.5 text-sm leading-relaxed text-site-ink">
            {prose && (
              <div className="guidy-prose break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, sanitizeSchema]]} skipHtml>
                  {prose}
                </ReactMarkdown>
              </div>
            )}
            {streaming && (
              <div className={cn(prose && 'mt-2')}>
                <StreamingCursor />
              </div>
            )}
          </div>
        </div>
      );
    }
    if (!prose) return null;
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-[var(--site-radius-card)] border border-site-line bg-site-surface px-3.5 py-2.5 text-sm leading-relaxed text-site-ink">
          <div className="guidy-prose break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, sanitizeSchema]]} skipHtml>
              {prose}
            </ReactMarkdown>
            {streaming && <StreamingCursor />}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={cn('max-w-[85%] rounded-[var(--site-radius-card)] px-3.5 py-2.5 text-sm leading-relaxed', message.failed ? 'border border-site-danger/40 bg-site-ink/90 text-site-bg' : 'bg-site-ink text-site-bg')}>
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
      </div>
      {message.failed && (
        <div className="flex items-center gap-2 text-xs text-site-danger">
          <span>发送失败</span>
          <button type="button" className="rounded border border-site-danger/40 px-2 py-0.5 text-site-danger hover:bg-site-danger/10" onClick={onRetry}>重试</button>
        </div>
      )}
    </div>
  );
}