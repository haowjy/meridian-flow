/** Persistence port for durable asks; lifecycle behavior is owned by the ask service in B2. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { AskKind, AskPayload, AskResolution, AskStatus } from "@meridian/contracts/threads";

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
  createdAt: Date;
  resolvedAt: Date | null;
};

export type CreateAskInput = Omit<StoredAsk, "id" | "createdAt" | "resolvedAt"> & {
  id?: string;
  resolvedAt?: Date | null;
};

export interface AskRepository {
  create(input: CreateAskInput): Promise<StoredAsk>;
  findById(id: string): Promise<StoredAsk | null>;
  findOpenByThread(threadId: ThreadId): Promise<StoredAsk | null>;
  listByThread(threadId: ThreadId): Promise<StoredAsk[]>;
  listOpenDueBy(deadline: Date, limit: number): Promise<StoredAsk[]>;
}
