/**
 * The handoff seed S on the destination: the brief card's state and the
 * stand-in seed the writer sees before the server has one. The seed's metadata
 * readers live in `@meridian/contracts/threads`.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { readHandoffBrief } from "@meridian/contracts/threads";

export type BriefCardState = "generating" | "ready" | "failed" | "stopped";

export type BriefCardView = {
  state: BriefCardState;
  brief: string | null;
  /** An ended brief a newer seed has replaced: its story is told, with nothing to act on. */
  superseded: boolean;
  /** Stop is offered while the brief is generating and no Stop is in flight. */
  canStop: boolean;
  /** Retry is offered only on the latest seed, once it ended without a brief. */
  canRetry: boolean;
};

/**
 * One brief card's view state. A pending seed is a brief being written: no
 * lease or phase says so, only S itself. `latest` is whether this is the
 * thread's newest seed; a Retry appends a newer one, so the old card loses
 * Retry the moment the new card appears.
 */
export function briefCardView(input: {
  turn: Turn;
  latest: boolean;
  stopping: boolean;
}): BriefCardView {
  const { turn, latest, stopping } = input;
  const state: BriefCardState =
    turn.status === "pending" || turn.status === "streaming"
      ? "generating"
      : turn.status === "complete"
        ? "ready"
        : turn.status === "cancelled"
          ? "stopped"
          : "failed";
  const ended = state === "failed" || state === "stopped";
  return {
    state,
    brief: state === "ready" ? readHandoffBrief(turn) : null,
    superseded: ended && !latest,
    canStop: state === "generating" && !stopping,
    canRetry: ended && latest,
  };
}

const OPTIMISTIC_SEED_PREFIX = "optimistic-seed:";

type SeedSource = {
  sourceThreadId: string;
  sourceRef?: string | null;
  sourceTitle: string | null;
  cutoffTurnId: string;
};

/**
 * A seed the writer sees before the server has it. With no `id`, it is the
 * first brief of a handoff whose destination is still being created: it has
 * no turn to stop yet (`isOptimisticSeed`). With the client-minted id of a
 * Retry, it is that retry's seed S2 at the leaf, and the server's S2 replaces
 * it by id.
 */
export function optimisticHandoffSeed(
  input: SeedSource & {
    threadId: string;
    createdAt: string;
    id?: string;
    position?: number;
    prevTurnId?: string | null;
  },
): Turn {
  return {
    id: input.id ?? `${OPTIMISTIC_SEED_PREFIX}${input.threadId}`,
    threadId: input.threadId,
    position: input.position ?? 1,
    prevTurnId: input.prevTurnId ?? null,
    role: "system",
    origin: "system",
    writeMode: null,
    status: "pending",
    promptBakeId: null,
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: input.sourceThreadId,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      sourceTitle: input.sourceTitle,
      cutoffTurnId: input.cutoffTurnId,
    },
    createdAt: input.createdAt,
    completedAt: null,
    blocks: [],
    executionId: null,
    reservedForUserTurnIds: [],
    delivery: null,
    forgottenBy: null,
    siblingIds: [],
    responses: [],
  };
}

/** The first brief's stand-in, before the destination exists: nothing to stop yet. */
export function isOptimisticSeed(turn: Turn): boolean {
  return turn.id.startsWith(OPTIMISTIC_SEED_PREFIX);
}
