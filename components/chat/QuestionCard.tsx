import { useState } from 'react';
import { HelpCircle, Send, X } from 'lucide-react';
import type { QuestionCardArtifact } from '@/shared/schemas';
import { composeAnswers, shouldSendImmediately } from '@/lib/questionCard';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * 信息不足时的追问卡片：单问题点选项直接发送；多问题先各选一项，
 * 再统一「发送回答」，避免只答了第一个就发出去。
 */
export function QuestionCard({ artifact, onAnswer, onDismiss }: {
  artifact: QuestionCardArtifact;
  onAnswer: (text: string) => void;
  onDismiss: () => void;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const immediate = shouldSendImmediately(artifact);
  const answered = Object.keys(answers).length;
  const total = artifact.questions.length;

  const pick = (index: number, option: string) => {
    if (immediate) {
      onAnswer(composeAnswers(artifact, { [index]: option }));
      return;
    }
    setAnswers((prev) => ({ ...prev, [index]: option }));
  };

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
          <p className="mt-0.5 text-xs text-site-ink-soft">
            {immediate ? '选一个答案直接回复，或在下方输入框补充。' : `每题选一项，选完一起发送（${answered}/${total}）。也可以在下方输入框补充。`}
          </p>
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
                {q.options.map((option) => {
                  const active = answers[i] === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={active}
                      onClick={() => pick(i, option)}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                        active
                          ? 'border-site-brand bg-site-brand/10 font-medium text-site-brand'
                          : 'border-site-line bg-site-surface text-site-ink-soft hover:border-site-brand/50 hover:text-site-ink',
                      )}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {!immediate && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onDismiss}>稍后再答</Button>
          <Button
            size="sm"
            className="dawn-gradient text-white"
            disabled={answered === 0}
            onClick={() => onAnswer(composeAnswers(artifact, answers))}
          >
            <Send className="mr-1 h-3.5 w-3.5" /> 发送回答（{answered}/{total}）
          </Button>
        </div>
      )}
    </div>
  );
}