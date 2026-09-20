/**
 * The canonical local (non-provider) turn builder. Turns that carry no model
 * response — the run's user/assistant skeleton, a drained steer, and the inbox
 * drain's persisted history — share one shape so the read model and context
 * projection see a single turn contract.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Turn } from "@meridian/contracts/threads";
import { toIsoString } from "../../threads/domain/contract-serialization.js";

export function createLocalTurn(input: {
  /** Deterministic identity for idempotent persistence; minted when omitted. */
  id?: TurnId;
  threadId: ThreadId;
  prevTurnId: TurnId | null;
  role: Turn["role"];
  status: Turn["status"];
  writeMode?: Turn["writeMode"];
  metadata?: Turn["metadata"];
  /** Durable origin time; a drained steer passes its inbox `enqueuedAt`. */
  createdAt?: string;
}): Turn {
  return {
    id: input.id ?? crypto.randomUUID(),
    threadId: input.threadId,
    prevTurnId: input.prevTurnId,
    parentTurnId: input.prevTurnId,
    role: input.role,
    writeMode: input.writeMode ?? null,
    status: input.status,
    finishReason: null,
    model: null,
    provider: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    totalMillicredits: "0",
    responseCount: 0,
    usage: emptyTurnUsage(),
    error: null,
    requestParams: null,
    responseMetadata: null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? toIsoString(new Date()),
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

function emptyTurnUsage(): NonNullable<Turn["usage"]> {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    totalMillicredits: "0",
    responseCount: 0,
  };
}
