import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { JsonValue, Turn } from "@meridian/contracts/threads";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import { compactionTurnMetadata } from "../../threads/index.js";
import type { CompactionDecision } from "./compaction/decision.js";
import type { CurrentTurn } from "./ports.js";

export function createLocalTurn(input: {
  id?: TurnId;
  threadId: ThreadId;
  position: number;
  prevTurnId: TurnId | null;
  role: Turn["role"];
  origin: Turn["origin"];
  status: Turn["status"];
  writeMode?: Turn["writeMode"];
  metadata?: Turn["metadata"];
  executionId?: string | null;
  reservedForUserTurnIds?: readonly string[];
}): Turn {
  return {
    id: input.id ?? crypto.randomUUID(),
    threadId: input.threadId,
    position: input.position,
    prevTurnId: input.prevTurnId,
    parentTurnId: input.prevTurnId,
    role: input.role,
    origin: input.origin,
    writeMode: input.writeMode ?? null,
    status: input.status,
    executionId: input.executionId ?? null,
    reservedForUserTurnIds: [...(input.reservedForUserTurnIds ?? [])],
    delivery: null,
    forgottenBy: null,
    promptBakeId: null,
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
    createdAt: toIsoString(new Date()),
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

function isRecord(value: Turn["metadata"]): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function currentTurnKind(turn: Pick<Turn, "role">): CurrentTurn["kind"] {
  if (turn.role === "assistant" || turn.role === "compaction") return turn.role;
  throw new Error(`Not a current execution turn: ${turn.role}`);
}

export function readCompactionTrigger(metadata: Turn["metadata"]): "auto" | "manual" {
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    metadata.trigger === "manual"
  )
    return "manual";
  return "auto";
}

export type ReservationIdentity = {
  executionId: string;
  reservedForUserTurnIds: readonly string[];
  retry?: { of: TurnId; replyTurnId: TurnId };
};

export function reservationTurn(
  input: Omit<
    Parameters<typeof createLocalTurn>[0],
    "role" | "origin" | "status" | "metadata" | "executionId" | "reservedForUserTurnIds"
  > & {
    metadata?: Turn["metadata"];
    identity: ReservationIdentity;
  },
  decision: CompactionDecision = { kind: "generate" },
): Turn {
  const { identity, ...local } = input;
  const retryOf: Record<string, JsonValue> = identity.retry
    ? { retryOf: identity.retry.of, retryReplyId: identity.retry.replyTurnId }
    : {};
  return createLocalTurn({
    ...local,
    executionId: identity.executionId,
    reservedForUserTurnIds: identity.reservedForUserTurnIds,
    role: decision.kind === "compact" ? "compaction" : "assistant",
    origin: decision.kind === "compact" ? "system" : "assistant",
    status: decision.kind === "compact" ? "pending" : "streaming",
    metadata:
      decision.kind === "compact"
        ? {
            trigger: decision.trigger,
            ...(decision.plan.outcome === "planned"
              ? compactionTurnMetadata({
                  compactedThrough: decision.plan.compactedThrough,
                  pinnedRequestTurnIds: decision.plan.pinnedRequests.map((turn) => turn.id),
                })
              : {}),
            ...(decision.controlMessageId ? { controlMessageId: decision.controlMessageId } : {}),
            ...(decision.instructions ? { instructions: decision.instructions } : {}),
            ...retryOf,
          }
        : identity.retry
          ? { ...(isRecord(input.metadata) ? input.metadata : {}), ...retryOf }
          : (input.metadata ?? null),
  });
}
