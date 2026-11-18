import { HelpCircle, X } from 'lucide-react';
import type { QuestionCardArtifact } from '@/shared/schemas';
import { Button } from '@/components/ui/button';

/**
 * 信息不足时的追问卡片：问题和选项都结构化展示，
 * 点选项直接把答案发出去，也可以忽略卡片在输入框自己回答。
 */
export function QuestionCard({ artifact, onAnswer, onDismiss }: {
  artifact: QuestionCardArtifact;
  onAnswer: (text: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="待确认的问题"
      className="animate-guidy-fade-up rounded-xl border border-[var(--site-dawn-line)]/40 bg-site-surface p-4 shadow-sm"
    >
      <div className="dawn-gradient mb-3 h-0.5 rounded-full" />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display flex items-center gap-1.5 text-sm font-semibold text-site-ink">
            <HelpCircle className="h-4 w-4 text-site-brand" />
            {artifact.title ?? '还需要确认'}
          </h3>
          <p className="mt-0.5 text-xs text-site-ink-soft">选一个答案直接回复，或在下方输入框补充。</p>
        </div>
        <button type="button" onClick={onDismiss} aria-label="忽略这些问题" className="rounded p-1 text-site-ink-soft hover:bg-site-surface-2">
          <X className="h-4 w-4" />
        </button>
      </div>

      <ul className="mt-3 space-y-3">
        {artifact.questions.map((q, i) => (
          <li key={i} className="rounded-lg border border-site-line bg-site-bg px-3 py-2">
            <p className="text-xs leading-snug text-site-ink">{q.text}</p>
            {q.options?.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {q.options.map((option) => (
                  <Button key={option} variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onAnswer(option)}>
                    {option}
                  </Button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}