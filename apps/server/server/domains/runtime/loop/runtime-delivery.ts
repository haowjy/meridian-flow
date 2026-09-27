/** Atomic inbox transitions; journal publication is part of every committed mutation. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  Block,
  ModelResponseReceivedRow,
  OrchestratorEvent,
  Turn,
} from "@meridian/contracts/threads";
import type { Notice } from "../../notices/index.js";
import type { WorkContextNotices } from "../../projects/index.js";
import type { CompactionDecision } from "./compaction/decision.js";
import type { FinalizedExecution, TerminalCause } from "./execution-finalizer.js";
import type { drainInbox, InboxDrain } from "./inbox-context.js";
import type { InboxMessage, InboxReader, Lease, MessageDraft } from "./ports.js";

export type DeliveryTransaction = {
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  acknowledge(ids: readonly string[]): Promise<void>;
  materializePrefix(): Promise<void>;
};
export type DeliveryProducer = Pick<RuntimeDelivery, "enqueue" | "withThreadLock">;
export type DeliveryBoundary = Pick<
  Parameters<typeof drainInbox>[0],
  "knownTurnIds" | "expectedLeafTurnId" | "prepareAdoptedTurn"
> & {
  lease: Lease;
  currentTurn: Turn;
  signal?: AbortSignal;
  /** Completes a placeholder in the same transaction as late adoption and reservation. */
  completeCurrent?: (preparationFailure: unknown | undefined) => Promise<Turn>;
  /** Prepare image decisions/breaks before the next assistant turn is reserved. */
  prepareNextContext: (drain: InboxDrain) => Promise<{
    events: OrchestratorEvent[];
    turns: Turn[];
    blocks: Block[];
    requiresSplit: boolean;
    compaction?: CompactionDecision;
  }>;
};
export type DeliverySelection = {
  batch: InboxMessage[];
  workContext?: import("./work-context.js").RenderedWorkContext;
  notices: Notice[];
  activeLeafTurnId: TurnId | null;
};
export type AdoptedBatch = {
  drain: InboxDrain;
  next: Turn;
  split: boolean;
  completed?: Turn;
  compaction?: Extract<CompactionDecision, { kind: "compact" }>;
  preparationFailure?: unknown;
};
export interface RuntimeDelivery
  extends WorkContextNotices,
    Pick<InboxReader, "selectPending" | "readPendingProjection" | "pendingMessageThreads"> {
  /** Reclassify expired leases after recovery or a backstop release. */
  refreshPending(threadId: ThreadId): Promise<void>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  /** Parent-first business transaction; the producer does not reacquire the lock. */
  withThreadLock<T>(
    threadId: ThreadId,
    operation: (producer: DeliveryTransaction) => Promise<T>,
  ): Promise<T>;
  /** Initial assistant setup and exact receipt commit before model execution. */
  adoptBatch<T>(
    lease: Lease,
    /** Pure preparation over the selection; transactional writes belong in `persist`. */
    prepare: (selection: DeliverySelection) => Promise<{
      value: T;
      turnId: TurnId;
      messageIds: readonly string[];
      /** Preparation failures still adopt messages and reserve a failed assistant turn. */
      preparationFailure?: unknown;
      /** Turn-start writes run under the lock, after external context is prepared. */
      persist?: () => Promise<void>;
    }>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
  ackWithResponse<T>(lease: Lease, ids: string[], persist: () => Promise<T>): Promise<T>;
  splitAndContinue(input: DeliveryBoundary): Promise<AdoptedBatch>;
  close(input: {
    lease: Lease;
    assistantTurnId: TurnId;
    cause: TerminalCause;
    modelResponses?: ModelResponseReceivedRow[];
    continueWith?: DeliveryBoundary;
  }): Promise<
    { kind: "split"; adopted: AdoptedBatch } | { kind: "completed"; completion: FinalizedExecution }
  >;
}
