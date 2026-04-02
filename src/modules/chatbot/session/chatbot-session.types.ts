export interface ChatbotSession {
  flowId: string;
  conversationId: string;
  currentNodeId: string;
  variables: Record<string, any>;
  waitingForInput: boolean;
  startedAt: string;
  lastActivityAt: string;
}
