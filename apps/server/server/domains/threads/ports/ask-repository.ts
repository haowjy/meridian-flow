/** Persistence port for durable asks; lifecycle behavior is owned by the ask service in B2. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  AskContinuationState,
  AskKind,
  AskPayload,
  AskResolution,
  AskStatus,
  JsonValue,
} from "@meridian/contracts/threads";

/**
 * A forwarded ask's hand-off to its child. `foreground`: the relay answered the
 * child's open ask, so its continuation is found by `childAskId`. `late`: the
 * child had already resolved, so the answer went as an ordinary message.
 */
export type AskRelay = {
  childAskId: string;
  mode: "foreground" | "late";
  messageId?: string;
  /** Null until the parent's tool result carries the child's report. */
  result: JsonValue | null;
};

export type StoredAsk = {
  id: string;
  threadId: ThreadId;
  askingTurnId: TurnId;
  executionId: string;
  toolCallId: string;
  kind: AskKind;
  payload: AskPayload;
  deadlineAt: Date | null;
  status: AskStatus;
  resolution: AskResolution | null;
  submissionId: string | null;
  relay: AskRelay | null;
  /** Null while live; see `AskContinuationState`. */
  continuation: AskContinuationState | null;
  /** The latest turn admitted to continue this ask. */
  continuationTurnId: TurnId | null;
  /** The child's ask this one forwards; a live copy cancels with its source. */
  forwardedFromAskId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

/** An ask a lineage cancellation claimed, and whether it was still live (its tool result is owed). */
export type ClaimedAsk = { ask: StoredAsk; wasLive: boolean };

export type CreateAskInput = Omit<
  StoredAsk,
  | "id"
  | "createdAt"
  | "resolvedAt"
  | "relay"
  | "continuation"
  | "continuationTurnId"
  | "forwardedFromAskId"
> & {
  id?: string;
  forwardedFromAskId?: string | null;
  resolvedAt?: Date | null;
  relay?: AskRelay | null;
};

export interface AskRepository {
  create(input: CreateAskInput): Promise<StoredAsk>;
  findById(id: string): Promise<StoredAsk | null>;
  listByIds(ids: readonly string[]): Promise<StoredAsk[]>;
  findLiveByTurnForUpdate(turnId: TurnId): Promise<StoredAsk | null>;
  findOpenByThread(threadId: ThreadId): Promise<StoredAsk | null>;
  findLiveByThread(threadId: ThreadId): Promise<StoredAsk | null>;
  /** Row-locks, in id order, the asks these threads hold: live asks and owed continuations. */
  lockHeldByThreads(threadIds: readonly ThreadId[]): Promise<void>;
  /**
   * The threads holding a live forwarded copy, at any remove, of an ask these threads hold. A copy
   * lives on its source thread's parent, so these are ancestors of `threadIds`' topmost thread.
   */
  listCopyHolders(threadIds: readonly ThreadId[]): Promise<ThreadId[]>;
  /** Row-locks these asks in id order. */
  lockByIds(ids: readonly string[]): Promise<void>;
  /**
   * One lineage cancellation's claim, in one statement: every live ask and owed continuation of
   * `threadIds`, and of `owner` the live asks (only `turnId`'s, when given) and the owed
   * continuations not admitted by the execution it spares, and every live copy forwarded from a
   * claimed ask, transitively. Live asks become cancelled; every claimed continuation becomes
   * `cancelled`.
   */
  claimLineage(input: {
    threadIds: readonly ThreadId[];
    owner: { threadId: ThreadId; turnId: TurnId | null; spare: string | null } | null;
  }): Promise<ClaimedAsk[]>;
  /**
   * Admits a resolved ask's continuation at `turnId`: a plain question's is then `done`, a
   * forwarded one's `admitted` until its relay completes (a crashed relay is admitted again).
   * Null when nothing is owed.
   */
  admitContinuation(input: {
    id: string;
    turnId: TurnId;
    forwarded: boolean;
  }): Promise<StoredAsk | null>;
  listByThread(threadId: ThreadId): Promise<StoredAsk[]>;
  listOpenDueBy(deadline: Date, limit: number): Promise<StoredAsk[]>;
  listByTurnIds(turnIds: readonly TurnId[]): Promise<StoredAsk[]>;
  recordRelayOnce(id: string, relay: AskRelay): Promise<StoredAsk>;
  /**
   * Writes the relay's result and ends the obligation (`done`), only for the turn admitted to
   * relay it; null when that admission was cancelled. `late` records a relay that went as an
   * ordinary message because the child's question had already resolved.
   */
  completeRelay(input: {
    id: string;
    turnId: TurnId;
    result: JsonValue;
    late?: Omit<AskRelay, "result">;
  }): Promise<StoredAsk | null>;
  openPending(id: string, turnId: TurnId, deadline: Date): Promise<StoredAsk | null>;
  cancelPendingByTurn(turnId: TurnId): Promise<StoredAsk[]>;
  resolveOpen(input: {
    id: string;
    status: Extract<AskStatus, "answered" | "expired" | "cancelled">;
    resolution: AskResolution;
    submissionId?: string | null;
    resolvedAt: Date;
  }): Promise<StoredAsk | null>;
  resolveLive(input: {
    id: string;
    status: Extract<AskStatus, "cancelled">;
    resolution: AskResolution;
    resolvedAt: Date;
  }): Promise<StoredAsk | null>;
}
