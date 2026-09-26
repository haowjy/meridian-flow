/** Shared types for the per-thread store. */
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
  /** Transient live-turn bookkeeping keyed by thread id. */
  liveMeta: Record<string, LiveTurnMeta>;
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
  removeAssistantBlock(threadId: string, blockId: string): void;
  invalidateThreadSnapshot(threadId: string): void;
  patchTurnStatus(
    threadId: string,
    turnId: string,
    status: TurnStatus,
    patch?: TurnStatusPatch,
  ): void;
  pruneStaleAssistantTurns(threadId: string): void;
  bumpEventsApplied(threadId: string): number;
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
  markPendingStream(threadId: string, start?: PendingStreamStart): void;
  consumePendingStream(threadId: string): PendingStreamStart | null;
  markPendingCreation(args: { projectId?: string; threadId: string }): void;
  clearPendingCreation(args: { projectId?: string; threadId?: string }): void;

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
