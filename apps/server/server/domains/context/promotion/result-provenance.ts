export interface ResultProvenance {
  rootThreadId: string;
  threadId: string;
  turnId: string;
  toolCallId: string | null;
  agentSlug: string;
}
