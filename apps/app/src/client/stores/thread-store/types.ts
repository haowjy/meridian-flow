/** Shared types for the per-thread store. */
import type { Thread, Turn, TurnStatus, UserMessageBlock } from "@meridian/contracts/protocol";
import type { JsonValue } from "@meridian/contracts/threads";
import type {
  EnsureAssistantTurnOptions,
  RunStateAction,
  RunStateView,
  TurnStatusPatch,
} from "@meridian/thread-client";
import type { SyncedThread, ThreadSyncPorts } from "@meridian/thread-client/sync";
import type {
  InterruptResponseEntry,
  InterruptResponseIdentity,
  InterruptResponseState,
} from "@/core/session/interrupt-response";

export type { EnsureAssistantTurnOptions, TurnStatusPatch };

/** Read surface — subscribe with `useThreadStore((s) => …)`. */
export type ThreadStoreState = {
  /** Stable reference time (epoch ms) for relative-time labels in chat. */
  now: number;
  /** One value per chat: turns, fences, positions and run state (see `SyncedThread`). */
  syncedByThread: Record<string, SyncedThread>;
  streamingThreadId: string | null;
  streamingProjectId: string | null;
  /**
   * Local interrupt-response send state keyed by `(threadId, turnId, interruptId)`.
   * Memory-only, cleared on the matching server resolution event or terminal turn.
   */
  interruptResponses: Record<string, InterruptResponseEntry>;
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
  /** Take a fact about the chat's run state into its slice (`@meridian/thread-client` `run-state-slice.ts`). */
  dispatchRunState(threadId: string, action: RunStateAction): void;
  markPendingCreation(args: { threadId: string }): void;
  clearPendingCreation(args: { threadId: string }): void;

  /** Read the tracked settlement for one tuple, if any (overlap guard). */
  interruptResponseFor(identity: InterruptResponseIdentity): InterruptResponseEntry | undefined;
  beginInterruptResponse(
    input: InterruptResponseIdentity & { value: JsonValue; generation: number },
  ): void;
  /**
   * Move a tracked response to a proven/ambiguous local failure state. Upserts,
   * because a send that never left the client has no pending row yet.
   */
  failInterruptResponse(
    input: InterruptResponseIdentity & { value: JsonValue },
    failure: InterruptResponseState,
  ): void;
  /** Clear the tracked response once the server resolves/expires the interrupt. */
  settleInterruptResponse(identity: InterruptResponseIdentity): void;
  /**
   * The newest pending response for a thread; used to correlate the thread-only
   * error frame. Null when the thread has no pending response.
   */
  pendingInterruptResponseForThread(threadId: string): InterruptResponseEntry | null;
  /**
   * Mark every still-pending response written on `generation` ambiguous. Called
   * when that socket closes before any matching resolution arrived.
   */
  markInterruptResponsesForGenerationAmbiguous(generation: number): void;
};
