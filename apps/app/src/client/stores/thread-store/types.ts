/**
 * thread-store types — the thread store's state/action contracts plus the
 * pending-stream / deferred-send handoff shape. The canonical thread store
 * vocabulary read by the chat flow and the Home→Project handoff.
 */
import type { Block, Thread, ThreadListItem, Turn, TurnStatus } from "@meridian/contracts/protocol";

export type PendingStreamStart = {
  after?: string;
  expectedTurnId?: string;
  /**
   * When set, the chat surface should create the project + thread on the
   * server and (optionally) send `text` as the first user message before
   * subscribing to the stream. Used by the Home → Project handoff so
   * navigation is instant. Empty `text` means "create only".
   */
  deferredSend?: {
    projectId: string;
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
  streamingProjectId: string | null;
};

/**
 * Mutations — use `useThreadActions()` only. Do not call from selectors.
 *
 * Per-project soft-delete + rename live in `ProjectStoreProvider`; this store
 * owns per-thread turns (optimistic + snapshot apply), handoff, streaming
 * coordination, and the pending-creation gate for optimistic Home → Project
 * navigation.
 */
export type ThreadStoreActions = {
  turns(id: string): Turn[] | undefined;
  setStreamingThreadId(id: string | null, projectId?: string | null): void;
  ensureThread(thread: Thread): void;
  setThreadAttention(threadId: string, attention: ThreadListItem["attention"]): void;
  markHandoffPending(threadId: string): void;
  appendUserTurn(threadId: string, text: string): Turn;
  acknowledgeUserTurn(
    threadId: string,
    optimisticTurnId: string,
    serverTurnId: string,
    ackHeadSeq: string,
  ): void;
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
    options?: {
      lifecycle?: Pick<ThreadListItem, "attention" | "runningTurnId">;
      nextSeq?: string;
    },
  ): void;
  markPendingStream(threadId: string, start?: PendingStreamStart): void;
  consumePendingStream(threadId: string): PendingStreamStart | null;
  /**
   * Mark a (projectId, threadId) pair as pending server creation. Set by the
   * optimistic Home → Project flow before navigation; cleared by the chat
   * handoff once `createProject` and `createThread` resolve on the server.
   * Consumed by data hooks (`useProjectThreads`, `useWorks`,
   * `useThreadSnapshotSync`) to gate fetches that would otherwise 404.
   */
  markPendingCreation(args: { projectId?: string; threadId: string }): void;
  clearPendingCreation(args: { projectId?: string; threadId?: string }): void;
};
