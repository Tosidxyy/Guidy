import { useEffect, useMemo, useRef } from 'react';
import { createChatStream } from '@/lib/sse';
import { createChatController, type ChatStream } from '@/lib/chatController';
import { useChatStore } from '@/store/useChatStore';
import { usePlanStore } from '@/store/usePlanStore';

export function useChat() {
  const streamRef = useRef<ChatStream | null>(null);
  if (!streamRef.current) streamRef.current = createChatStream() as ChatStream;
  const controller = useMemo(() => createChatController({ store: useChatStore, stream: streamRef.current!, getPlanId: () => usePlanStore.getState().state.plan.id }), []);
  useEffect(() => () => streamRef.current?.cancel(), []);
  return controller;
}