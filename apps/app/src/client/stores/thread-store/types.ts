/**
 * thread-store types — the thread store's state/action contracts plus the
 * pending-stream / standalone-creation handoff shape. The canonical thread store
 * vocabulary read by the chat flow and the standalone creation handoff.
 */
import type { AgentSelection } from "@meridian/contracts/agents";
import type { Block, Thread, ThreadListItem, Turn, TurnStatus } from "@meridian/contracts/protocol";
import type { JsonValue } from "@meridian/contracts/threads";
import type {
  InterruptResponseEntry,
  InterruptResponseIdentity,
  InterruptResponseState,
} from "@/core/session/interrupt-response";

export type PendingStreamStart = {
  after?: string;
  expectedTurnId?: string;
  /**
   * When set, the chat surface should persist the thread on the server and
   * (optionally) send `text` as the first user message before subscribing.
   * Empty `text` means "create only". Independent chat also creates the project.
   */
  creation?: {
    projectId: string;
    title: string;
    text: string;
    agentSelection: AgentSelection;
    workId?: string | null;
    optimisticUserTurnId?: string;
    workingTurnId?: string;
    submissionId?: string;
    activatedSkillSlugs?: readonly string[];
    createProject?: boolean;
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
  writeMode?: Turn["writeMode"];
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
  /**
   * Local interrupt-response send state keyed by `(threadId, turnId, interruptId)`.
   * Memory-only, cleared on the matching server resolution event or terminal turn.
   */
  interruptResponses: Record<string, InterruptResponseEntry>;
};

/**
 * Mutations — use `useThreadActions()` only. Do not call from selectors.
 *
 * Per-project soft-delete + rename live in `ProjectStoreProvider`; this store
 * owns per-thread turns (optimistic + snapshot apply), handoff, streaming
 * coordination, and the pending-creation gate for optimistic standalone creation
 * navigation.
 */
export type ThreadStoreActions = {
  turns(id: string): Turn[] | undefined;
  setStreamingThreadId(id: string | null, projectId?: string | null): void;
  ensureThread(thread: Thread): void;
  markHandoffPending(threadId: string): void;
  appendUserTurn(threadId: string, text: string): Turn;
  acknowledgeUserTurn(
    threadId: string,
    optimisticTurnId: string,
    serverTurnId: string,
    snapshotFloorNextSeq: string,
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
    options: {
      lifecycle: Pick<ThreadListItem, "actionRequired" | "runningTurnId">;
      nextSeq: string;
    },
  ): void;
  markPendingStream(threadId: string, start?: PendingStreamStart): void;
  consumePendingStream(threadId: string): PendingStreamStart | null;
  /**
   * Mark a (projectId, threadId) pair as pending server creation. Set by the
   * optimistic standalone creation flow before navigation; cleared by the chat
   * handoff once `createProject` and `createThread` resolve on the server.
   * Consumed by data hooks (`useProjectThreads`, `useWorks`,
   * `useThreadSnapshotSync`) to gate fetches that would otherwise 404.
   */
  markPendingCreation(args: { projectId?: string; threadId: string }): void;
  clearPendingCreation(args: { projectId?: string; threadId?: string }): void;

  /** Read the tracked settlement for one tuple, if any (overlap guard). */
  interruptResponseFor(identity: InterruptResponseIdentity): InterruptResponseEntry | undefined;
  /**
   * Record an interrupt response as pending on the wire and expose its state to
   * the card. The value is retained so Retry can reuse the correlation tuple;
   * `generation` is the socket the frame was written on.
   */
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
