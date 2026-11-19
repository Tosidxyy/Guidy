import { describe, expect, it } from 'vitest';
import { composeAnswers, shouldSendImmediately } from '@/lib/questionCard';

const card = {
  type: 'question_card' as const,
  title: '三分化训练安排',
  questions: [
    { text: '每周想练几次？', options: ['每周3练', '每周6练'] },
    { text: '训练放在哪个时段？', options: ['早上 07:00–08:30', '晚上 22:30 之后'] },
  ],
};

describe('questionCard', () => {
  it('多问题：按问题顺序拼成一条消息，只带已作答的行', () => {
    expect(composeAnswers(card, { 0: '每周3练', 1: '早上 07:00–08:30' })).toBe('每周想练几次？：每周3练\n训练放在哪个时段？：早上 07:00–08:30');
    expect(composeAnswers(card, { 1: '晚上 22:30 之后' })).toBe('训练放在哪个时段？：晚上 22:30 之后');
    expect(composeAnswers(card, {})).toBe('');
  });

  it('单问题点击即发送，多问题先收集再发送', () => {
    expect(shouldSendImmediately({ ...card, questions: [card.questions[0]] })).toBe(true);
    expect(shouldSendImmediately(card)).toBe(false);
  });

  it('自定义回答文本去空白参与拼接，空输入不计入', () => {
    expect(composeAnswers(card, { 0: '  每周4练，周末加一次  ', 1: '   ' })).toBe('每周想练几次？：每周4练，周末加一次');
    expect(composeAnswers(card, { 0: '' })).toBe('');
  });
});