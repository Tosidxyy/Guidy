import { createChatStream } from '@/lib/sse';
import { createChatController } from '@/lib/chatController';
import { useChatStore } from '@/store/useChatStore';
import { usePlanStore } from '@/store/usePlanStore';

// 应用级单例：ChatPanel 与 usePlanManager 共用一条 SSE stream，避免编排时产生第二条流。
export const chatController = createChatController({
  store: useChatStore,
  stream: createChatStream(),
  getPlanId: () => usePlanStore.getState().state.plan.id,
});

// 回合结束（done/error）后自动续发排队消息。
useChatStore.subscribe((state, prev) => {
  if (prev.streaming && !state.streaming && state.queued.length) {
    setTimeout(() => chatController.pump(), 200);
  }
});