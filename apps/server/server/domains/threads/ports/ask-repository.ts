/** Persistence port for durable asks; lifecycle behavior is owned by the ask service in B2. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  AskContinuationState,
  AskKind,
  AskPayload,
  AskResolution,
  AskStatus,
} from "@meridian/contracts/threads";

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
  /** Null while live; see `AskContinuationState`. */
  continuation: AskContinuationState | null;
  /** The latest turn admitted to continue this ask. */
  continuationTurnId: TurnId | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

/** An ask a lineage cancellation claimed, and whether it was still live (its tool result is owed). */
export type ClaimedAsk = { ask: StoredAsk; wasLive: boolean };

export type CreateAskInput = Omit<
  StoredAsk,
  "id" | "createdAt" | "resolvedAt" | "continuation" | "continuationTurnId"
> & {
  id?: string;
  resolvedAt?: Date | null;
};

export interface AskRepository {
  create(input: CreateAskInput): Promise<StoredAsk>;
  findById(id: string): Promise<StoredAsk | null>;
  findLiveByTurnForUpdate(turnId: TurnId): Promise<StoredAsk | null>;
  findOpenByThread(threadId: ThreadId): Promise<StoredAsk | null>;
  findLiveByThread(threadId: ThreadId): Promise<StoredAsk | null>;
  /**
   * One lineage cancellation's claim, in one statement: every live ask and owed continuation of
   * `threadIds`, and of `owner` the live asks (only `turnId`'s, when given) and owed
   * continuations. Live asks become cancelled; every claimed continuation becomes `cancelled`.
   * Rows another transaction holds are skipped: it waits on a thread lock the command holds and
   * then sees the cancellation (a flagged run cancels its own ask; a writer's answer wins).
   */
  claimLineage(input: {
    threadIds: readonly ThreadId[];
    owner: { threadId: ThreadId; turnId: TurnId | null } | null;
  }): Promise<ClaimedAsk[]>;
  /** Admits a resolved ask's owed continuation at `turnId` (`done`); null when nothing is owed. */
  admitContinuation(input: { id: string; turnId: TurnId }): Promise<StoredAsk | null>;
  listByThread(threadId: ThreadId): Promise<StoredAsk[]>;
  listOpenDueBy(deadline: Date, limit: number): Promise<StoredAsk[]>;
  listByTurnIds(turnIds: readonly TurnId[]): Promise<StoredAsk[]>;
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
