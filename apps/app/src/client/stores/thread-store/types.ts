// @ts-nocheck
/**
 * thread-store types — the thread store's state/action contracts plus the
 * pending-stream / deferred-send handoff shape. The canonical thread store
 * vocabulary read by the chat flow and the Home→Workbench handoff.
 */
import type { Block, Thread, ThreadListItem, Turn, TurnStatus } from "@meridian/contracts/protocol";

export type PendingStreamStart = {
  after?: string;
  expectedTurnId?: string;
  /**
   * When set, the chat surface should create the workbench + thread on the
   * server and (optionally) send `text` as the first user message before
   * subscribing to the stream. Used by the Home → Workbench handoff so
   * navigation is instant. Empty `text` means "create only".
   */
  deferredSend?: {
    workbenchId: string;
    title: string;
    text: string;
    /** Mars agent slug bound at thread creation (Home composer handoff). */
    currentAgent?: string;
    /**
     * Client-only user turn id created before deferred navigation. The HTTP
     * append acknowledgement rewrites this row to the server turn id so the
     * first snapshot cannot render both bubbles.
     */
    optimisticUserTurnId?: string;
  };
};

export type LiveTurnMeta = {
  /**
   * Count of live protocol events applied to this thread.
   *
   * Unit: event applications, not block count. The unified-block reducer will
   * use this to generate deterministic opaque/process block IDs without
   * storing reducer-frontier counters on the contract `Turn`.
   */
  eventsApplied: number;
  /**
   * Contract `Turn.id` for the assistant turn currently streaming on this
   * thread. `null` means no assistant turn is active.
   */
  runningTurnId: string | null;
};

export type EnsureAssistantTurnOptions = {
  createdAt?: string;
  prevTurnId?: string | null;
};

export type TurnStatusPatch = Partial<
  Pick<
    Turn,
    | "completedAt"
    | "usage"
    | "error"
    | "finishReason"
    | "inputTokens"
    | "outputTokens"
    | "reasoningTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "totalCostUsd"
    | "totalMillicredits"
    | "responseCount"
  >
>;

/** Read surface — subscribe with `useThreadStore((s) => …)`. */
export type ThreadStoreState = {
  /** Stable reference time (epoch ms) for relative-time labels in chat. */
  now: number;
  /**
   * Transient live-turn bookkeeping keyed by thread id.
   *
   * These values are store mechanics only. They must not be copied onto the
   * JSON-natural contract `Turn`/`Block` objects that snapshots persist.
   */
  liveMeta: Record<string, LiveTurnMeta>;
  streamingThreadId: string | null;
  streamingWorkbenchId: string | null;
};

/**
 * Mutations — use `useThreadActions()` only. Do not call from selectors.
 *
 * Per-workbench soft-delete + rename live in `WorkbenchStoreProvider`; this store
 * owns per-thread turns (optimistic + snapshot apply), handoff, streaming
 * coordination, and the pending-creation gate for optimistic Home → Workbench
 * navigation.
 */
export type ThreadStoreActions = {
  turns(id: string): Turn[] | undefined;
  rename(id: string, title: string): void;
  setStreamingThreadId(id: string | null, workbenchId?: string | null): void;
  ensureThread(thread: Thread): void;
  markHandoffPending(threadId: string): void;
  appendUserTurn(threadId: string, text: string): Turn;
  acknowledgeUserTurn(threadId: string, optimisticTurnId: string, serverTurnId: string): void;
  removeOptimisticUserTurn(threadId: string, optimisticTurnId: string): void;
  ensureAssistantTurn(threadId: string, turnId: string, opts?: EnsureAssistantTurnOptions): void;
  upsertAssistantBlock(threadId: string, turnId: string, block: Block): void;
  patchTurnStatus(
    threadId: string,
    turnId: string,
    status: TurnStatus,
    patch?: TurnStatusPatch,
  ): void;
  pruneStaleAssistantTurns(threadId: string): void;
  bumpEventsApplied(threadId: string): number;
  applyThreadSnapshot(
    thread: Thread,
    turns: Turn[],
    lifecycle?: Pick<ThreadListItem, "waitingForUser" | "runningTurnId">,
  ): void;
  markPendingStream(threadId: string, start?: PendingStreamStart): void;
  consumePendingStream(threadId: string): PendingStreamStart | null;
  /**
   * Mark a (workbenchId, threadId) pair as pending server creation. Set by the
   * optimistic Home → Workbench flow before navigation; cleared by the chat
   * handoff once `createWorkbench` and `createThread` resolve on the server.
   * Consumed by data hooks (`useWorkbenchThreads`, `useWorks`,
   * `useThreadSnapshotSync`) to gate fetches that would otherwise 404.
   */
  markPendingCreation(args: { workbenchId?: string; threadId: string }): void;
  clearPendingCreation(args: { workbenchId?: string; threadId?: string }): void;
};
