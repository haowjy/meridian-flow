/** Atomic inbox transitions; journal publication is part of every committed mutation. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  Block,
  HandBackRequest,
  HandBackResponse,
  OrchestratorEvent,
  RunState,
  SendNowRequest,
  SendNowResponse,
  StopRequest,
  StopResponse,
  Turn,
} from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { Notice } from "../../notices/index.js";
import type { WorkContextNotices } from "../../projects/index.js";
import type { CompactionDecision } from "./compaction/decision.js";
import type { FinalizedExecution, TerminalCause } from "./execution-finalizer.js";
import type { drainInbox, InboxDrain } from "./inbox-context.js";
import type { InboxWorkSelection } from "./next-inbox-work.js";
import type { InboxMessage, InboxReader, Lease, MessageDraft } from "./ports.js";
import type { ReferenceEvidence } from "./reference-context.js";

/** The same request id arrived with a different body: refused, as an admission is. */
export class HandBackConflictError extends Error {
  readonly code = "hand_back_conflict" as const;
  constructor(readonly requestId: string) {
    super(`Hand-back request ${requestId} was already used with another body`);
    this.name = "HandBackConflictError";
  }
}

export type DeliveryTransaction = {
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  acknowledge(ids: readonly string[]): Promise<void>;
  /** Materialize every eligible predecessor before placing this writer turn. */
  materializePrefix(): Promise<void>;
  /**
   * Appends the chat's run-state record now and returns its stream version, so an admission can store
   * it. Null where no record is published.
   */
  publishRunState(): Promise<string | null>;
};
export type DeliveryProducer = Pick<RuntimeDelivery, "enqueue" | "withThreadLock">;
export type ThreadControls = Pick<
  RuntimeDelivery,
  "enqueueControl" | "withdrawControl" | "effectiveWriteMode"
>;
export type DeliveryBoundary<TCurrent = undefined> = Pick<
  Parameters<typeof drainInbox>[0],
  "knownTurnIds" | "expectedLeafTurnId" | "prepareAdoptedTurn"
> & {
  lease: Lease;
  currentTurn: Turn;
  /** Use this client-minted id for the next assistant after a start-time compaction. */
  preferredSuccessorTurnId?: TurnId;
  /**
   * Messages the execution still carries for its first assistant: a Retry's
   * failed-reply list through a start-time compaction. Those inbox rows are
   * already acknowledged, so the inbox selection can't supply them.
   */
  carriedReservedForUserTurnIds?: readonly string[];
  signal?: AbortSignal;
  continueTask?: boolean;
  /**
   * Records adopted reference reads' evidence (shown links under the turn whose
   * request carries them, frontiers on their blocks) inside the adoption commit,
   * after its blocks are projected; required when a drain has any.
   */
  recordEvidence?: (turnId: TurnId, evidence: ReferenceEvidence) => Promise<void>;
  /** Admits the run's execution; `adopted` are the outstanding messages it now answers. */
  admit?: (turn: Turn, adopted: readonly InboxMessage[]) => Promise<void>;
  /** Prepare the current placeholder before late arrivals; retried with the same selection. */
  prepareCurrent?: () => Promise<TCurrent>;
  /** Completes a placeholder in the same transaction as late adoption and reservation. */
  current:
    | { kind: "assistant" }
    | {
        kind: "placeholder";
        complete: (
          prepared: TCurrent | undefined,
          failure: unknown | undefined,
        ) => Promise<{ turn: Turn; blocks: Block[] }>;
      };
  /** Prepare image decisions/breaks before the next assistant turn is reserved. */
  prepareNextContext: (
    drain: InboxDrain,
    current: TCurrent | undefined,
    selection: DeliveryBoundarySelection,
  ) => Promise<{
    events: OrchestratorEvent[];
    turns: Turn[];
    blocks: Block[];
    requiresSplit: boolean;
    compaction?: CompactionDecision;
    context?: import("./request-preparation.js").PreparedContinuation;
    successorFailure?: unknown;
  }>;
};
export type DeliverySelectionFields = {
  batch: InboxMessage[];
  /** Pending messages beyond this boundary; a fresh run must exclude their persisted turns. */
  deferred: InboxMessage[];
  continueTask?: boolean;
  outstanding: InboxMessage[];
  workContext?: import("./work-context.js").RenderedWorkContext;
  notices: Notice[];
  activeLeafTurnId: TurnId | null;
};
export type DeliverySelection = DeliverySelectionFields & {
  next: InboxWorkSelection;
};
export type DeliveryBoundarySelection = DeliverySelectionFields & {
  /** A message waits behind the queued write-mode switch: end the reply here. */
  yieldReply: boolean;
};
export type AdoptedBatch<TCurrent = undefined> = {
  drain: InboxDrain;
  next: Turn;
  split: boolean;
  /**
   * The execution ended in this commit: a placeholder with nothing left, or a
   * compaction successor whose preparation failed (`next` is that failed turn).
   */
  terminal?: boolean;
  completed?: Turn;
  /** Blocks the completion persisted (a compaction's summary and re-shown documents). */
  completedBlocks?: Block[];
  compaction?: Extract<CompactionDecision, { kind: "compact" }>;
  preparationFailure?: unknown;
  preparedCurrent?: TCurrent;
  context?: import("./request-preparation.js").PreparedContinuation;
  /**
   * The reply ends at this request boundary for a queued switch. An assistant
   * exits through a success close; a placeholder comes back `terminal`.
   */
  yielded?: boolean;
};
export interface RuntimeDelivery
  extends WorkContextNotices,
    Pick<InboxReader, "selectPending" | "readPendingProjection" | "pendingMessageThreads"> {
  /** Save a credit-gated start refusal under the current run claim. */
  blockForUsage(lease: Lease): Promise<void>;
  /** Append a transcript command to the thread's ordinary ordered inbox. */
  enqueueControl(input: {
    threadId: ThreadId;
    provenance: import("@meridian/contracts/threads").MessageProvenance;
    id: string;
    control: import("@meridian/contracts/threads").ControlBody;
  }): Promise<{
    created: boolean;
    response: import("@meridian/contracts/threads").EnqueueThreadControlResponse;
  }>;
  withdrawControl(
    threadId: ThreadId,
    controlId: string,
  ): Promise<import("@meridian/contracts/threads").WithdrawThreadControlResponse>;
  /** The mode the writer sees: a pending switch's, else the chat's applied mode. */
  effectiveWriteMode(threadId: ThreadId): Promise<AiWriteMode>;
  /** Whether a message waits behind the queued switch, so the next request boundary ends the reply. */
  yieldsAtBoundary(threadId: ThreadId): Promise<boolean>;
  /**
   * Under a newly acquired claim, before anything else the holder does: repair
   * every orphaned turn (primary and child-report paths), then end the stale
   * lease row's execution and
   * delete the row in one transaction. A no-op on a settled thread.
   */
  settleStaleExecution<T = void>(
    threadId: ThreadId,
    /**
     * A sweep lane's own repair, under an exclusive session claim: only the
     * turns it names settle, and the row is released (its end journaled) only
     * when the repair retired its receipt or the receipt was already empty.
     */
    repair?: () => Promise<T>,
  ): Promise<T | void>;
  /**
   * The run owner's cleanup: unlock only when the row is gone, end the
   * execution when every turn it reserved is terminal, else abandon it for
   * `settleStaleExecution`.
   */
  releaseExecution(lease: Lease): Promise<"released" | "ended" | "abandoned">;
  /** Retire only the adopted inbox receipt owned by a crash-finalized reply. */
  retireOrphanedReply(threadId: ThreadId, turnId: TurnId): Promise<void>;
  /** Clear a crash-finalized non-reply selector without acknowledging its messages. */
  clearOrphanedTurn(threadId: ThreadId, turnId: TurnId): Promise<void>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  /** The run-state record a command answers with, read under the chat's thread lock. */
  answerRunState(threadId: ThreadId): Promise<RunState>;
  /**
   * Takes waiting writer messages out of the chat and returns their content (the queue's x and Cancel
   * queue). Decided once under the thread lock and stored by request id; a replay answers the same.
   */
  handBack(threadId: ThreadId, request: HandBackRequest): Promise<HandBackResponse>;
  /**
   * Stop: hands back every writer message in the press set that no execution has taken on, and flags
   * the open execution for cancellation when the rule says so. Only flags; the run session aborts.
   */
  stop(threadId: ThreadId, request: StopRequest): Promise<StopResponse>;
  /**
   * Send now: flags the open execution for cancellation when it is the one the writer saw and has
   * taken on none of the waiting messages. Hands nothing back; only flags, the run session aborts.
   */
  sendNow(threadId: ThreadId, request: SendNowRequest): Promise<SendNowResponse>;
  /** Parent-first business transaction; the producer does not reacquire the lock. */
  withThreadLock<T>(
    threadId: ThreadId,
    operation: (producer: DeliveryTransaction) => Promise<T>,
  ): Promise<T>;
  /** Initial assistant setup and exact receipt commit before model execution. */
  adoptBatch<T>(
    lease: Lease,
    /**
     * Pure preparation; writes belong in `persist`. Null starts nothing; `retire` acknowledges
     * stale controls (a hint whose ask owes nothing) and starts nothing.
     * A queued write-mode switch that is due has already applied: the selection never offers it.
     */
    prepare: (selection: DeliverySelection) => Promise<
      | {
          value: T;
          completedControlIds?: string[];
          turnId: TurnId;
          turnKind: "assistant" | "compaction";
          messageIds: readonly string[];
          /** Preparation failures still adopt messages and reserve a failed assistant turn. */
          preparationFailure?: unknown;
          /** Turn-start writes run under the lock, after external context is prepared. */
          persist?: () => Promise<void>;
        }
      | { retire: readonly string[] }
      | null
    >,
    options?: {
      signal?: AbortSignal;
      /**
       * The failed reply a Retry re-answers. A Retry starts a reply by itself,
       * so a queued switch is due at its run start; once any switch has landed,
       * looking past trailing switch turns must still reach this reply, else
       * the Retry is refused (a newer message or another Retry moved the leaf).
       */
      retryOf?: TurnId;
    },
  ): Promise<T>;
  /** Persists a response and delivers `ids` by `byTurn`, the assistant it answers them with. */
  ackWithResponse<T>(
    lease: Lease,
    ids: string[],
    byTurn: Pick<Turn, "id" | "position">,
    persist: () => Promise<T>,
  ): Promise<T>;
  splitAndContinue<TCurrent = undefined>(
    input: DeliveryBoundary<TCurrent>,
  ): Promise<AdoptedBatch<TCurrent>>;
  close(input: {
    lease: Lease;
    turnId: TurnId;
    cause: TerminalCause;
    /**
     * The run's local abort (a parent's cancel, shutdown) as a terminal cause,
     * or null. The lease never records it, so close rereads it under the lock
     * beside the durable cancel flag.
     */
    localCancellation?: () => TerminalCause | null;
    settleSummaryResponses?: () => Promise<void>;
    /** Ask the loop for a guarded continuation when input still waits. Never prepares it. */
    continueOnPending?: boolean;
  }): Promise<{ kind: "continue" } | { kind: "completed"; completion: FinalizedExecution }>;
}
