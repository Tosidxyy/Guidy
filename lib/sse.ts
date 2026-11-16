import { createConversationStream } from './vendor/conversation-stream.mjs';
import { useChatStore } from '@/store/useChatStore';
export function createChatStream() {
  return createConversationStream((frame: { event: string; data: string }) => {
    const data = JSON.parse(frame.data);
    useChatStore.getState().applyFrame({ event: frame.event, data });
    // The backend emits the terminal status before the artifact (parsed after
    // upstream closes), so only done/error end the stream, not a terminal status.
    return frame.event === 'done' || frame.event === 'error';
  });
}