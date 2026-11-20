import { useState } from 'react';
import { ArrowUp, Check, HelpCircle, X } from 'lucide-react';
import type { QuestionCardArtifact } from '@/shared/schemas';
import { composeAnswers, shouldSendImmediately, CUSTOM_ANSWER_LABEL } from '@/lib/questionCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * 信息不足时的追问卡片：单问题点普通选项直接发送；多问题先各选一项再统一发送。
 * 每题末尾固定追加「自定义回答」：选中后展开输入框，卡片转为确认模式，写完再发。
 */
export function QuestionCard({ artifact, onAnswer, onDismiss }: {
  artifact: QuestionCardArtifact;
  onAnswer: (text: string) => void;
  onDismiss: () => void;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [custom, setCustom] = useState<Record<number, boolean>>({});
  const immediate = shouldSendImmediately(artifact);
  const needsInput = artifact.questions.some((q) => !q.options?.length);
  const confirmMode = !immediate || needsInput || Object.values(custom).some(Boolean);
  const answered = Object.values(answers).filter((v) => v.trim()).length;
  const total = artifact.questions.length;

  const pick = (index: number, option: string) => {
    if (option === CUSTOM_ANSWER_LABEL) {
      setCustom((prev) => ({ ...prev, [index]: true }));
      setAnswers((prev) => ({ ...prev, [index]: '' }));
      return;
    }
    setCustom((prev) => ({ ...prev, [index]: false }));
    if (!confirmMode) {
      onAnswer(composeAnswers(artifact, { [index]: option }));
      return;
    }
    setAnswers((prev) => ({ ...prev, [index]: option }));
  };

  return (
    <div
      role="dialog"
      aria-label="待确认的问题"
      className="animate-guidy-fade-up rounded-(--site-radius) border border-site-line bg-site-surface p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display flex items-center gap-1.5 text-sm font-semibold text-site-ink">
            <HelpCircle className="h-4 w-4 text-site-ink" />
            {artifact.title ?? '还需要确认'}
          </h3>
          <p className="mt-0.5 text-xs text-site-ink-soft">
            {confirmMode
              ? `每题选一项或自定义回答，选完一起发送（${answered}/${total}）。也可以在下方输入框补充。`
              : '选一个答案直接回复；选「自定义回答」可输入自己的答案。'}
          </p>
        </div>
        <button type="button" onClick={onDismiss} aria-label="忽略这些问题" className="rounded p-1 text-site-ink-soft hover:bg-site-surface-2">
          <X className="h-4 w-4" />
        </button>
      </div>

      <ul className="guidy-stagger mt-3 space-y-3">
        {artifact.questions.map((q, i) => {
          const showInput = custom[i] || !q.options?.length;
          return (
            <li key={i} className="rounded-[var(--site-radius-card)] border border-site-line bg-site-bg px-3 py-2">
              <p className="text-xs leading-snug text-site-ink">{q.text}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(q.options ?? []).map((option) => {
                  const active = !custom[i] && answers[i] === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={active}
                      onClick={() => pick(i, option)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-[var(--site-radius-control)] border px-3 py-1.5 text-[13px] transition-all duration-[var(--site-motion-quick)] active:scale-[0.97]',
                        active
                          ? 'border-site-ink bg-site-ink font-medium text-site-bg'
                          : 'border-site-line bg-site-surface text-site-ink hover:border-site-ink/40 hover:bg-site-surface-2',
                      )}
                    >
                      {active && <Check className="h-3.5 w-3.5" />}
                      {option}
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-pressed={!!custom[i]}
                  onClick={() => pick(i, CUSTOM_ANSWER_LABEL)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-[var(--site-radius-control)] border border-dashed px-3 py-1.5 text-[13px] transition-all duration-[var(--site-motion-quick)] active:scale-[0.97]',
                    custom[i]
                      ? 'border-site-ink bg-site-ink font-medium text-site-bg'
                      : 'border-site-line bg-site-surface text-site-ink hover:border-site-ink/40 hover:bg-site-surface-2',
                  )}
                >
                  {custom[i] && <Check className="h-3.5 w-3.5" />}
                  {CUSTOM_ANSWER_LABEL}
                </button>
              </div>
              {showInput && (
                <Input
                  autoFocus
                  value={answers[i] ?? ''}
                  maxLength={200}
                  placeholder="输入你的回答…"
                  aria-label={`自定义回答 ${q.text}`}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
                  className="mt-2 h-8 text-xs"
                />
              )}
            </li>
          );
        })}
      </ul>

      {confirmMode && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onDismiss}>稍后再答</Button>
          <Button
            size="sm"
            disabled={answered === 0}
            onClick={() => onAnswer(composeAnswers(artifact, answers))}
          >
            <ArrowUp className="mr-1 h-3.5 w-3.5" /> 发送回答（{answered}/{total}）
          </Button>
        </div>
      )}
    </div>
  );
}