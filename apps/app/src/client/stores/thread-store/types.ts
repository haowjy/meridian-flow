import type { Thread, Turn, TurnStatus, UserMessageBlock } from "@meridian/contracts/protocol";
import type {
  ChatAsks,
  RunStateAction,
  RunStateView,
  TurnStatusPatch,
} from "@meridian/thread-client";
import type { SyncedThread, ThreadSyncPorts } from "@meridian/thread-client/sync";

export type { TurnStatusPatch };

export type ThreadStoreState = {
  now: number;
  syncedByThread: Record<string, SyncedThread>;
  streamingThreadId: string | null;
  streamingProjectId: string | null;
};

export type ThreadStoreActions = {
  turns(id: string): Turn[] | undefined;
  runState(id: string): RunStateView;
  syncPorts(threadId: string): Pick<ThreadSyncPorts, "state" | "observe">;
  setStreamingThreadId(id: string | null, projectId?: string | null): void;
  ensureThread(thread: Thread): void;
  appendUserTurn(threadId: string, blocks: readonly UserMessageBlock[]): Turn;
  acknowledgeUserTurn(
    threadId: string,
    optimisticTurnId: string,
    serverTurnId: string,
    snapshotFloorNextSeq: string,
  ): void;
  removeOptimisticUserTurn(threadId: string, optimisticTurnId: string): void;
  invalidateThreadSnapshot(threadId: string): void;
  patchTurnStatus(
    threadId: string,
    turnId: string,
    status: TurnStatus,
    patch?: TurnStatusPatch,
  ): void;
  pruneStaleAssistantTurns(threadId: string): void;
  removeTurns(threadId: string, ids: readonly string[], seq: string): void;
  updateAsks(threadId: string, change: (asks: ChatAsks) => ChatAsks): void;
  dispatchRunState(threadId: string, action: RunStateAction): void;
  markPendingCreation(args: { threadId: string }): void;
  clearPendingCreation(args: { threadId: string }): void;
};
