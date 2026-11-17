import { describe, expect, it } from 'vitest';
import { conversationForPlan } from '@/lib/planConversation';

const items = [{ id: 'a', plan_id: 'p1' }, { id: 'b', plan_id: 'p2' }, { id: 'c', plan_id: null }];
describe('conversationForPlan', () => {
  it('取首个 plan_id 匹配项', () => { expect(conversationForPlan(items, 'p2')?.id).toBe('b'); });
  it('null 匹配草稿桶', () => { expect(conversationForPlan(items, null)?.id).toBe('c'); });
  it('无匹配 → null', () => { expect(conversationForPlan(items, 'p9')).toBeNull(); });
  it('空列表 → null', () => { expect(conversationForPlan([], 'p1')).toBeNull(); });
  it('多个匹配取传入顺序首个', () => {
    const dup = [{ id: 'x', plan_id: 'p1' }, { id: 'y', plan_id: 'p1' }];
    expect(conversationForPlan(dup, 'p1')?.id).toBe('x');
  });
});