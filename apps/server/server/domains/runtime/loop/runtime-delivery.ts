import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  Block,
  ControlBody,
  EnqueueThreadControlResponse,
  HandBackRequest,
  HandBackResponse,
  MessageProvenance,
  OrchestratorEvent,
  RunState,
  SendNowRequest,
  SendNowResponse,
  StopRequest,
  StopResponse,
  Turn,
  WithdrawThreadControlResponse,
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
import type { PreparedContinuation } from "./request-preparation.js";
import type { RenderedWorkContext } from "./work-context.js";

export class HandBackConflictError extends Error {
  readonly code = "hand_back_conflict" as const;
  constructor(readonly requestId: string) {
    super(`Hand-back request ${requestId} was already used with another body`);
    this.name = "HandBackConflictError";
  }
}

export class LostRunError extends Error {
  constructor(readonly lease: Lease) {
    super(`Run ${lease.executionId} lost its lease`);
    this.name = "LostRunError";
  }
}

export type DeliveryTransaction = {
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  acknowledge(ids: readonly string[]): Promise<void>;
  materializePrefix(): Promise<void>;
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
  preferredSuccessorTurnId?: TurnId;
  carriedReservedForUserTurnIds?: readonly string[];
  signal?: AbortSignal;
  continueTask?: boolean;
  recordEvidence?: (turnId: TurnId, evidence: ReferenceEvidence) => Promise<void>;
  admit?: (turn: Turn, adopted: readonly InboxMessage[]) => Promise<void>;
  prepareCurrent?: () => Promise<TCurrent>;
  current:
    | { kind: "assistant" }
    | {
        kind: "placeholder";
        complete: (
          prepared: TCurrent | undefined,
          failure: unknown | undefined,
        ) => Promise<{ turn: Turn; blocks: Block[] }>;
      };
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
    context?: PreparedContinuation;
    successorFailure?: unknown;
  }>;
};
export type DeliverySelectionFields = {
  batch: InboxMessage[];
  deferred: InboxMessage[];
  continueTask?: boolean;
  outstanding: InboxMessage[];
  workContext?: RenderedWorkContext;
  notices: Notice[];
  activeLeafTurnId: TurnId | null;
};
export type DeliverySelection = DeliverySelectionFields & {
  next: InboxWorkSelection;
};
export type DeliveryBoundarySelection = DeliverySelectionFields & {
  yieldReply: boolean;
};
export type AdoptedBatch<TCurrent = undefined> = {
  drain: InboxDrain;
  next: Turn;
  split: boolean;
  terminal?: boolean;
  completed?: Turn;
  completedBlocks?: Block[];
  compaction?: Extract<CompactionDecision, { kind: "compact" }>;
  preparationFailure?: unknown;
  preparedCurrent?: TCurrent;
  context?: PreparedContinuation;
  yielded?: boolean;
};
export interface RuntimeDelivery
  extends WorkContextNotices,
    Pick<InboxReader, "selectPending" | "readPendingProjection" | "pendingMessageThreads"> {
  blockForUsage(lease: Lease): Promise<void>;
  enqueueControl(input: {
    threadId: ThreadId;
    provenance: MessageProvenance;
    id: string;
    control: ControlBody;
  }): Promise<{
    created: boolean;
    response: EnqueueThreadControlResponse;
  }>;
  withdrawControl(threadId: ThreadId, controlId: string): Promise<WithdrawThreadControlResponse>;
  effectiveWriteMode(threadId: ThreadId): Promise<AiWriteMode>;
  yieldsAtBoundary(threadId: ThreadId): Promise<boolean>;
  settleStaleExecution<T = void>(
    threadId: ThreadId,
    repair?: () => Promise<T>,
  ): Promise<T | undefined>;
  releaseExecution(lease: Lease): Promise<"released" | "ended" | "abandoned">;
  retireOrphanedReply(threadId: ThreadId, turnId: TurnId): Promise<void>;
  clearOrphanedTurn(threadId: ThreadId, turnId: TurnId): Promise<void>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  answerRunState(threadId: ThreadId): Promise<RunState>;
  handBack(threadId: ThreadId, request: HandBackRequest): Promise<HandBackResponse>;
  stop(threadId: ThreadId, request: StopRequest): Promise<StopResponse>;
  sendNow(threadId: ThreadId, request: SendNowRequest): Promise<SendNowResponse>;
  withThreadLock<T>(
    threadId: ThreadId,
    operation: (producer: DeliveryTransaction) => Promise<T>,
  ): Promise<T>;
  adoptBatch<T>(
    lease: Lease,
    prepare: (selection: DeliverySelection) => Promise<
      | {
          value: T;
          completedControlIds?: string[];
          turnId: TurnId;
          turnKind: "assistant" | "compaction";
          messageIds: readonly string[];
          preparationFailure?: unknown;
          persist?: () => Promise<void>;
        }
      | { retire: readonly string[] }
      | null
    >,
    options?: {
      signal?: AbortSignal;
      retryOf?: TurnId;
    },
  ): Promise<T>;
  ackWithResponse<T>(
    lease: Lease,
    ids: string[],
    byTurn: Pick<Turn, "id" | "position">,
    persist: () => Promise<T>,
  ): Promise<T>;
  storeUnderLease<T>(lease: Lease, persist: () => Promise<T>): Promise<T>;
  splitAndContinue<TCurrent = undefined>(
    input: DeliveryBoundary<TCurrent>,
  ): Promise<AdoptedBatch<TCurrent>>;
  close(input: {
    lease: Lease;
    turnId: TurnId;
    cause: TerminalCause;
    localCancellation?: () => TerminalCause | null;
    settleSummaryResponses?: () => Promise<void>;
    continueOnPending?: boolean;
  }): Promise<{ kind: "continue" } | { kind: "completed"; completion: FinalizedExecution }>;
}
