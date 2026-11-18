import type { QuestionCardArtifact } from '@/shared/schemas';

/** 把卡片上选中的答案拼成一条用户消息：按问题顺序，只带已作答的行。 */
export function composeAnswers(artifact: QuestionCardArtifact, answers: Record<number, string>): string {
  return artifact.questions
    .map((q, i) => (answers[i] ? `${q.text}：${answers[i]}` : null))
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** 单问题卡片点一下即发送；多问题卡片要先收齐再发，避免只答一半。 */
export function shouldSendImmediately(artifact: QuestionCardArtifact): boolean {
  return artifact.questions.length === 1;
}