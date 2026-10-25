/** Shared types for the per-thread store. */
import type { Thread, Turn, TurnStatus, UserMessageBlock } from "@meridian/contracts/protocol";
import type {
  ChatAsks,
  RunStateAction,
  RunStateView,
  TurnStatusPatch,
} from "@meridian/thread-client";
import type { SyncedThread, ThreadSyncPorts } from "@meridian/thread-client/sync";

export type { TurnStatusPatch };

/** Read surface — subscribe with `useThreadStore((s) => …)`. */
export type ThreadStoreState = {
  /** Stable reference time (epoch ms) for relative-time labels in chat. */
  now: number;
  /** One value per chat: turns, fences, positions and run state (see `SyncedThread`). */
  syncedByThread: Record<string, SyncedThread>;
  streamingThreadId: string | null;
  streamingProjectId: string | null;
};

/** Mutations — use `useThreadActions()` only. */
export type ThreadStoreActions = {
  turns(id: string): Turn[] | undefined;
  /** The chat's run-state view (the initial one before any fact). */
  runState(id: string): RunStateView;
  /**
   * The ports a `ThreadSync` for this chat needs from the store: its value, and the app's effects
   * for what the sync observes.
   */
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
  /** Remove turns that left the conversation, keeping a tombstone at `seq` (see `removeTurnsIn`). */
  removeTurns(threadId: string, ids: readonly string[], seq: string): void;
  /** Apply a change to the chat's asks (`@meridian/thread-client` `asks/`). */
  updateAsks(threadId: string, change: (asks: ChatAsks) => ChatAsks): void;
  /** Take a fact about the chat's run state into its slice (`@meridian/thread-client` `run-state-slice.ts`). */
  dispatchRunState(threadId: string, action: RunStateAction): void;
  markPendingCreation(args: { threadId: string }): void;
  clearPendingCreation(args: { threadId: string }): void;
};
