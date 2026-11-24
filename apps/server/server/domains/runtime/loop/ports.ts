import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  ControlBody,
  CurrentToolCall,
  MessageIntent,
  MessageProvenance,
  ThreadLeaseState,
  ThreadPhase,
  ThreadStatus,
} from "@meridian/contracts/threads";

export type ExecutionId = string;
export type CurrentTurn = { id: TurnId; kind: "assistant" | "compaction" };

export const DEFAULT_LEASE_TTL_MS = 30_000;

export type { ThreadPhase, ThreadStatus };

export type ContextPart = { source: string; text: string };

export type AskResolvedBody = { kind: "ask_resolved"; askId: string };

export type MessageBody =
  | ControlBody
  | AskResolvedBody
  | { kind: "text"; text: string }
  | { kind: "context"; parts: ContextPart[] }
  | { kind: "work_context_refresh" };

export interface MessageDraft {
  threadId: ThreadId;
  intent: MessageIntent;
  provenance: MessageProvenance;
  body: MessageBody;
  idempotencyKey: string;
  id?: string;
  sender?: { threadId: ThreadId; executionId: ExecutionId };
}

export interface InboxMessage extends Omit<MessageDraft, "sender"> {
  id: string;
  seq: number;
  enqueuedAt: string;
  deliveredAt: string | null;
}

export interface InboxReader {
  selectPending(threadId: ThreadId): Promise<InboxMessage[]>;
  readPendingProjection(threadId: ThreadId): Promise<InboxProjection>;
  pendingMessageThreads(limit: number, afterThreadId?: ThreadId): Promise<ThreadId[]>;
}

export type InboxProjection = {
  blocked?: { reason: "credits_exhausted" };
  messages: InboxMessage[];
  run: { turnId: TurnId | null; messageIds: string[] } | null;
};

export interface Lease {
  threadId: ThreadId;
  executionId: ExecutionId;
  holderId: string;
}

export interface HeldRunClaim {
  release(): Promise<void>;
  onLost(listener: () => void): () => void;
}

export type WakeRefusal = "sender_stopped" | "receiver_stopped";

export interface RunClaim {
  hold(threadId: ThreadId): Promise<HeldRunClaim | null>;
  withExclusiveThread<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T | null>;
  startExecution(
    threadId: ThreadId,
    executionId: ExecutionId,
    settle: () => Promise<void>,
  ): Promise<Lease | null>;
  renew(lease: Lease): Promise<boolean>;
  holder(threadId: ThreadId): Promise<ExecutionId | null>;
  publish(lease: Lease, phase: ThreadPhase): Promise<void>;
  setCurrentTool(lease: Lease, currentTool: CurrentToolCall): Promise<boolean>;
  read(threadId: ThreadId): Promise<ThreadStatus>;
  readOwned(lease: Lease): Promise<{ cancelRequested: boolean } | null>;
  readMany(threadIds: readonly ThreadId[]): Promise<Map<ThreadId, ThreadLeaseState>>;
  readRunningTurnId(threadId: ThreadId): Promise<TurnId | null>;
  cancelExecution(threadId: ThreadId, turnId: TurnId): Promise<boolean>;
  requestCancel(threadIds: readonly ThreadId[]): Promise<void>;
  fenceWakes(threadIds: readonly ThreadId[]): Promise<void>;
  wakeRefusal(input: {
    sender: { threadId: ThreadId; executionId: ExecutionId };
    receiver: ThreadId | null;
  }): Promise<WakeRefusal | null>;
  readOpenExecutionId(threadId: ThreadId): Promise<ExecutionId | null>;
  listExpiredExecutions(limit: number, afterThreadId?: ThreadId): Promise<ThreadId[]>;
  release(lease: Lease): Promise<boolean>;
  abandon(lease: Lease): Promise<void>;
}

export interface RunStarter {
  start(threadId: ThreadId): Promise<void>;
}
