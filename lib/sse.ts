import { createConversationStream } from './vendor/conversation-stream.mjs';
import { useChatStore } from '@/store/useChatStore';
const TERMINAL = ['completed', 'failed', 'interrupted'];
export function createChatStream() {
  return createConversationStream((frame: { event: string; data: string }) => {
    const data = JSON.parse(frame.data);
    useChatStore.getState().applyFrame({ event: frame.event, data });
    return frame.event === 'done' || frame.event === 'error' || (frame.event === 'status' && TERMINAL.includes(data.state));
  });
}