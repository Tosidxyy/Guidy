export interface ConversationFrame {
  event: string;
  id?: string;
  data: string;
}
export function createConversationStream(
  applyFrame: (frame: ConversationFrame) => boolean | void,
): {
  cancel(): void;
  read(openResponse: (signal: AbortSignal) => Promise<Response>): Promise<void>;
};