/** Shared types for the per-thread store. */
import type {
  AGUIEvent,
  Block,
  Thread,
  ThreadListItem,
  Turn,
  TurnStatus,
  UserMessageBlock,
} from "@meridian/contracts/protocol";
import type { JsonValue } from "@meridian/contracts/threads";
import type {
  AwaitingDivider,
  EnsureAssistantTurnOptions,
  RunStateAction,
  RunStateView,
  SwitchTurnFacts,
  TurnStatusPatch,
} from "@meridian/thread-client";
import type { SyncedThread } from "@meridian/thread-client/sync";
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
  /** Held switch dividers whose anchor turn the transcript lacks: only a newer snapshot resolves them. */
  dividersAwaitingAnchor(id: string): AwaitingDivider[];
  /** The chat's run-state view (the initial one before any fact). */
  runState(id: string): RunStateView;
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
  ensureAssistantTurn(threadId: string, turnId: string, opts?: EnsureAssistantTurnOptions): void;
  /** Add the write-mode divider a `switched` frame names (see `ensureSwitchTurnIn`). */
  ensureSwitchTurn(threadId: string, facts: SwitchTurnFacts, seq: string): void;
  upsertAssistantBlock(threadId: string, turnId: string, block: Block): void;
  invalidateThreadSnapshot(threadId: string): void;
  patchTurnStatus(
    threadId: string,
    turnId: string,
    status: TurnStatus,
    patch?: TurnStatusPatch,
  ): void;
  pruneStaleAssistantTurns(threadId: string): void;
  bumpEventsApplied(threadId: string): number;
  /** Reduce one live stream event through this store's turn reducer. */
  applyTurnEvent(threadId: string, event: AGUIEvent, seq?: string): void;
  /** Remove turns that left the conversation, keeping a tombstone at `seq` (see `removeTurnsIn`). */
  removeTurns(threadId: string, ids: readonly string[], seq: string): void;
  /** Stamp failed turns that left the conversation, remembering every id (see `markForgottenIn`). */
  markForgotten(threadId: string, ids: readonly string[], byTurnId: string): void;
  /** Take a fact about the chat's run state into its slice (`@meridian/thread-client` `run-state-slice.ts`). */
  dispatchRunState(threadId: string, action: RunStateAction): void;
  /** Reduce one durable block event; false when it is malformed or for another thread. */
  applyDurableBlockEvent(threadId: string, event: AGUIEvent): boolean;
  /** Admit a durable block wire sequence, independent of run cursor rewinds. */
  acceptDurableBlockSeq(threadId: string, seq: string): boolean;
  /** Whether an acquired snapshot may affect cache, lifecycle, store, or handoff. */
  acceptsThreadSnapshot(threadId: string, nextSeq: string): boolean;
  applyThreadSnapshot(
    thread: Thread,
    turns: Turn[],
    options: {
      lifecycle: Pick<ThreadListItem, "actionRequired" | "runningTurnId">;
      nextSeq: string;
    },
  ): boolean;
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
