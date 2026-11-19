import type { QuestionCardArtifact } from '@/shared/schemas';

/** 每个问题末尾固定追加的自定义回答选项（UI 追加，不属于模型产物）。 */
export const CUSTOM_ANSWER_LABEL = '自定义回答';

/** 把卡片上选中的答案拼成一条用户消息：按问题顺序，只带已作答的行。 */
export function composeAnswers(artifact: QuestionCardArtifact, answers: Record<number, string>): string {
  return artifact.questions
    .map((q, i) => (answers[i]?.trim() ? `${q.text}：${answers[i].trim()}` : null))
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** 单问题卡片点一下即发送；多问题卡片要先收齐再发，避免只答一半。 */
export function shouldSendImmediately(artifact: QuestionCardArtifact): boolean {
  return artifact.questions.length === 1;
}