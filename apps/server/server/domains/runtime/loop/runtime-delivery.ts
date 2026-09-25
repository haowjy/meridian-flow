/** Atomic inbox transitions; journal publication is part of every committed mutation. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Turn } from "@meridian/contracts/threads";
import type { WorkContextNotices } from "../../projects/index.js";
import type { FinalizedExecution, TerminalCause } from "./execution-finalizer.js";
import type { drainInbox, InboxDrain } from "./inbox-context.js";
import type { InboxMessage, InboxReader, Lease, MessageDraft } from "./ports.js";

export type DeliveryTransaction = {
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  materializePrefix(): Promise<void>;
};
export type DeliveryProducer = Pick<RuntimeDelivery, "enqueue" | "withThreadLock">;
export type DeliveryBoundary = Pick<
  Parameters<typeof drainInbox>[0],
  "knownTurnIds" | "expectedLeafTurnId" | "prepareAdoptedTurn" | "loadActivatedSkillBodies"
> & {
  lease: Lease;
  currentTurn: Turn;
};
export type AdoptedBatch = { drain: InboxDrain; next: Turn; split: boolean };
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
    prepare: (
      batch: InboxMessage[],
      workContext?: import("./work-context.js").RenderedWorkContext,
    ) => Promise<{ value: T; turnId: TurnId; messageIds: readonly string[] }>,
  ): Promise<T>;
  ackWithResponse<T>(lease: Lease, ids: string[], persist: () => Promise<T>): Promise<T>;
  splitAndContinue(input: DeliveryBoundary): Promise<AdoptedBatch>;
  close(input: {
    lease: Lease;
    assistantTurnId: TurnId;
    cause: TerminalCause;
    continueWith?: DeliveryBoundary;
  }): Promise<
    { kind: "split"; adopted: AdoptedBatch } | { kind: "completed"; completion: FinalizedExecution }
  >;
}
