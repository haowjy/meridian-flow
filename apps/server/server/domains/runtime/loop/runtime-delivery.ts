/** Atomic inbox transitions; journal publication is part of every committed mutation. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import type { Notice } from "../../notices/index.js";
import type { WorkContextNotices } from "../../projects/index.js";
import type { CompactionDecision } from "./compaction/decision.js";
import type { FinalizedExecution, TerminalCause } from "./execution-finalizer.js";
import type { drainInbox, InboxDrain } from "./inbox-context.js";
import type { InboxWorkSelection } from "./next-inbox-work.js";
import type { InboxMessage, InboxReader, Lease, MessageDraft } from "./ports.js";

export type DeliveryTransaction = {
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  acknowledge(ids: readonly string[]): Promise<void>;
  materializePrefix(): Promise<void>;
};
export type DeliveryProducer = Pick<RuntimeDelivery, "enqueue" | "withThreadLock">;
export type ThreadControls = Pick<RuntimeDelivery, "enqueueControl" | "withdrawControl">;
export type DeliveryBoundary<TCurrent = undefined> = Pick<
  Parameters<typeof drainInbox>[0],
  "knownTurnIds" | "expectedLeafTurnId" | "prepareAdoptedTurn"
> & {
  lease: Lease;
  currentTurn: Turn;
  /** Use this client-minted id for the next assistant after a start-time compaction. */
  preferredSuccessorTurnId?: TurnId;
  signal?: AbortSignal;
  continueTask?: boolean;
  admit?: (turn: Turn) => Promise<void>;
  /** Prepare the current placeholder before late arrivals; retried with the same selection. */
  prepareCurrent?: () => Promise<TCurrent>;
  /** Completes a placeholder in the same transaction as late adoption and reservation. */
  current:
    | { kind: "assistant" }
    | {
        kind: "placeholder";
        complete: (prepared: TCurrent | undefined, failure: unknown | undefined) => Promise<Turn>;
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
    context?: import("./turn-context-assembly.js").AssembledNextTurnContext;
    successorFailure?: unknown;
  }>;
};
export type DeliverySelectionFields = {
  batch: InboxMessage[];
  continueTask?: boolean;
  outstanding: InboxMessage[];
  workContext?: import("./work-context.js").RenderedWorkContext;
  notices: Notice[];
  activeLeafTurnId: TurnId | null;
};
export type DeliverySelection = DeliverySelectionFields & {
  next: InboxWorkSelection;
  failedControlIds?: ReadonlySet<string>;
};
export type DeliveryBoundarySelection = DeliverySelectionFields;
export type AdoptedBatch<TCurrent = undefined> = {
  drain: InboxDrain;
  next: Turn;
  split: boolean;
  terminal?: boolean;
  completed?: Turn;
  compaction?: Extract<CompactionDecision, { kind: "compact" }>;
  preparationFailure?: unknown;
  preparedCurrent?: TCurrent;
  context?: import("./turn-context-assembly.js").AssembledNextTurnContext;
};
export interface RuntimeDelivery
  extends WorkContextNotices,
    Pick<InboxReader, "selectPending" | "readPendingProjection" | "pendingMessageThreads"> {
  /** Give pending commands the same run-first priority as Stop on a live run. */
  prioritizePendingControls(threadId: ThreadId): Promise<void>;
  enqueueControl(input: {
    threadId: ThreadId;
    actorId: string;
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
  /** Reclassify expired leases after recovery or a backstop release. */
  refreshPending(threadId: ThreadId): Promise<void>;
  /** Settle any previous primary assistant before a new run selects context. */
  repairOrphanedTurns(lease: Lease): Promise<void>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  /** Parent-first business transaction; the producer does not reacquire the lock. */
  withThreadLock<T>(
    threadId: ThreadId,
    operation: (producer: DeliveryTransaction) => Promise<T>,
  ): Promise<T>;
  /** Initial assistant setup and exact receipt commit before model execution. */
  adoptBatch<T>(
    lease: Lease,
    /** Pure preparation; writes belong in `persist`. Null retires stale controls without a reservation. */
    prepare: (selection: DeliverySelection) => Promise<{
      value: T;
      terminal?: boolean;
      completedControlIds?: string[];
      turnId: TurnId;
      turnKind: "assistant" | "compaction";
      messageIds: readonly string[];
      /** Preparation failures still adopt messages and reserve a failed assistant turn. */
      preparationFailure?: unknown;
      /** Turn-start writes run under the lock, after external context is prepared. */
      persist?: () => Promise<void>;
    } | null>,
    options?: {
      signal?: AbortSignal;
    },
  ): Promise<T>;
  ackWithResponse<T>(lease: Lease, ids: string[], persist: () => Promise<T>): Promise<T>;
  splitAndContinue<TCurrent = undefined>(
    input: DeliveryBoundary<TCurrent>,
  ): Promise<AdoptedBatch<TCurrent>>;
  close(input: {
    lease: Lease;
    turnId: TurnId;
    cause: TerminalCause;
    settleSummaryResponses?: () => Promise<void>;
    continueWith?: DeliveryBoundary;
  }): Promise<
    { kind: "split"; adopted: AdoptedBatch } | { kind: "completed"; completion: FinalizedExecution }
  >;
}
