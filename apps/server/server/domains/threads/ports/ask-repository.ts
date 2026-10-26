/** Persistence port for durable asks; lifecycle behavior is owned by the ask service in B2. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
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
  createdAt: Date;
  resolvedAt: Date | null;
};

export type CreateAskInput = Omit<StoredAsk, "id" | "createdAt" | "resolvedAt" | "relay"> & {
  id?: string;
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
  /** Live asks owned by this thread and every descendant, parent before child. */
  listLiveByLineage(threadId: ThreadId): Promise<StoredAsk[]>;
  listByThread(threadId: ThreadId): Promise<StoredAsk[]>;
  listOpenDueBy(deadline: Date, limit: number): Promise<StoredAsk[]>;
  listByTurnIds(turnIds: readonly TurnId[]): Promise<StoredAsk[]>;
  recordRelayOnce(id: string, relay: AskRelay): Promise<StoredAsk>;
  completeRelay(id: string, result: JsonValue): Promise<StoredAsk>;
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
