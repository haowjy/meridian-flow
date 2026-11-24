import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  AskContinuationState,
  AskKind,
  AskPayload,
  AskResolution,
  AskStatus,
  DraftAnswers,
  PermissionWorkCommand,
} from "@meridian/contracts/threads";

export type StoredAsk = {
  id: string;
  threadId: ThreadId;
  askingTurnId: TurnId;
  executionId: string;
  toolCallId: string;
  kind: AskKind;
  payload: AskPayload;
  permissionCommand: Record<string, unknown> | null;
  openedAt: Date | null;
  deadlineAt: Date | null;
  hardLimitSeconds: number;
  draftAnswers: DraftAnswers | null;
  status: AskStatus;
  resolution: AskResolution | null;
  submissionId: string | null;
  continuation: AskContinuationState | null;
  continuationTurnId: TurnId | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

export type ClaimedAsk = { ask: StoredAsk; wasLive: boolean };

export type CreateAskInput = Omit<
  StoredAsk,
  | "id"
  | "createdAt"
  | "resolvedAt"
  | "continuation"
  | "continuationTurnId"
  | "permissionCommand"
  | "openedAt"
  | "draftAnswers"
> & {
  id?: string;
  permissionCommand: PermissionWorkCommand | null;
  resolvedAt?: Date | null;
};

export interface AskRepository {
  create(input: CreateAskInput): Promise<StoredAsk>;
  findById(id: string): Promise<StoredAsk | null>;
  findLiveByTurnForUpdate(turnId: TurnId): Promise<StoredAsk | null>;
  findOpenByThread(threadId: ThreadId): Promise<StoredAsk | null>;
  findLiveByThread(threadId: ThreadId): Promise<StoredAsk | null>;
  claimLineage(input: {
    threadIds: readonly ThreadId[];
    owner: { threadId: ThreadId; turnId: TurnId | null; execution: string | null } | null;
  }): Promise<ClaimedAsk[]>;
  admitContinuation(input: { id: string; turnId: TurnId }): Promise<StoredAsk | null>;
  listByThread(threadId: ThreadId): Promise<StoredAsk[]>;
  listOpenDueBy(deadline: Date, limit: number): Promise<StoredAsk[]>;
  listByTurnIds(turnIds: readonly TurnId[]): Promise<StoredAsk[]>;
  openPending(
    id: string,
    turnId: TurnId,
    opening: { openedAt: Date; deadline: Date | null },
  ): Promise<StoredAsk | null>;
  recordPresence(input: {
    id: string;
    deadline: Date;
    draftAnswers?: DraftAnswers;
  }): Promise<StoredAsk | null>;
  cancelPendingByTurn(turnId: TurnId): Promise<StoredAsk[]>;
  resolveOpen(input: {
    id: string;
    status: Extract<AskStatus, "answered" | "expired" | "cancelled">;
    resolution: AskResolution;
    submissionId?: string | null;
    resolvedAt: Date;
    dueBy?: Date;
  }): Promise<StoredAsk | null>;
  resolveLive(input: {
    id: string;
    status: Extract<AskStatus, "cancelled">;
    resolution: AskResolution;
    resolvedAt: Date;
  }): Promise<StoredAsk | null>;
}
