import { describe, expect, it } from 'vitest';
import { chatController } from '@/lib/chatRuntime';
import { useChatStore } from '@/store/useChatStore';

describe('chatRuntime 单例', () => {
  it('newConversation 重置 chatStore', () => {
    useChatStore.setState({ conversationId: 'old', restoreDone: true, messages: [{ seq: 1, role: 'user', kind: 'text', content: 'hi' }] });
    chatController.newConversation();
    const s = useChatStore.getState();
    expect(s.conversationId).toBeNull();
    expect(s.messages).toHaveLength(0);
    expect(s.restoreDone).toBe(true);
  });
  it('多次导入为同一实例', async () => {
    const a = await import('@/lib/chatRuntime');
    const b = await import('@/lib/chatRuntime');
    expect(a.chatController).toBe(b.chatController);
  });
});