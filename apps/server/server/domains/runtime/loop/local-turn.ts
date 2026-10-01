/**
 * The canonical local (non-provider) turn builder. Turns that carry no model
 * response — the run's user/assistant skeleton, a drained message, and the inbox
 * drain's persisted history — share one shape so the read model and context
 * projection see a single turn contract.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Turn } from "@meridian/contracts/threads";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import { compactionTurnMetadata } from "../../threads/index.js";
import type { CompactionDecision } from "./compaction/decision.js";
import type { CurrentTurn } from "./ports.js";

export function createLocalTurn(input: {
  /** Deterministic identity for idempotent persistence; minted when omitted. */
  id?: TurnId;
  threadId: ThreadId;
  position: number;
  prevTurnId: TurnId | null;
  role: Turn["role"];
  /** Who authored the turn; no default, so every caller must decide. */
  origin: Turn["origin"];
  status: Turn["status"];
  writeMode?: Turn["writeMode"];
  metadata?: Turn["metadata"];
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

/** The role-to-kind rule for run-owned turns; SQL bindTurn mirrors this rule. */
export function currentTurnKind(turn: Pick<Turn, "role">): CurrentTurn["kind"] {
  if (turn.role === "assistant" || turn.role === "compaction") return turn.role;
  throw new Error(`Not a current execution turn: ${turn.role}`);
}

/** Read the reservation-time trigger before compaction outcome metadata exists. */
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

/** Both run-start and split reservation use the boundary's decision unchanged. */
export function reservationTurn(
  input: Omit<Parameters<typeof createLocalTurn>[0], "role" | "origin" | "status" | "metadata"> & {
    metadata?: Turn["metadata"];
  },
  decision: CompactionDecision = { kind: "generate" },
): Turn {
  return createLocalTurn({
    ...input,
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
          }
        : (input.metadata ?? null),
  });
}
