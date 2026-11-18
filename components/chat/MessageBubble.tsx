import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { Sparkles } from 'lucide-react';
import type { ChatMessage } from '@/store/useChatStore';
import { sanitizeSchema } from '@/lib/markdown';
import { splitArtifactText } from '@/lib/artifactText';
import { cn } from '@/lib/utils';
import { StreamingCursor } from './StreamingCursor';
import { ArtifactGenerating } from './ArtifactGenerating';

export function MessageBubble({ message, streaming, clarificationPending }: { message: ChatMessage; streaming?: boolean; clarificationPending?: boolean }) {
  if (message.kind === 'constraint_set' || message.kind === 'patch' || message.kind === 'question_card') {
    const artifactLabel = message.kind === 'question_card'
      ? '已生成待确认的问题'
      : message.kind === 'patch'
        ? '已生成调整建议'
        : clarificationPending
          ? '已生成初版约束方案，请先回答下方问题'
          : '已生成约束方案，请在上方方案卡核对';
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-[var(--site-dawn-line)]/30 bg-[var(--site-dawn-soft)] px-3 py-2 text-xs text-site-ink">
        <Sparkles className="h-3.5 w-3.5 text-[var(--site-dawn-line)]" />
        {artifactLabel}
      </div>
    );
  }
  if (message.role === 'system' || message.kind === 'status' || message.kind === 'error') {
    return <p className="px-1 text-center text-[11px] text-site-ink-soft">{message.content}</p>;
  }
  const isUser = message.role === 'user';
  if (!isUser) {
    const { prose, artifactJson } = splitArtifactText(message.content);
    if (artifactJson !== null) {
      if (!streaming && !prose) return null;
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-2xl border border-site-line bg-site-surface px-3.5 py-2.5 text-sm leading-relaxed text-site-ink">
            {prose && (
              <div className="guidy-prose break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, sanitizeSchema]]} skipHtml>
                  {prose}
                </ReactMarkdown>
              </div>
            )}
            {streaming && (
              <div className={cn(prose && 'mt-2')}>
                <ArtifactGenerating />
              </div>
            )}
          </div>
        </div>
      );
    }
  }
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
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, sanitizeSchema]]} skipHtml>
              {message.content}
            </ReactMarkdown>
            {streaming && <StreamingCursor />}
          </div>
        )}
      </div>
    </div>
  );
}