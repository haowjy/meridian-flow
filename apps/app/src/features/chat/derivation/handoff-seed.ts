import type { Turn } from "@meridian/contracts/protocol";
import { readHandoffBrief } from "@meridian/contracts/threads";

export type BriefCardState = "generating" | "ready" | "failed" | "stopped";

export type BriefCardView = {
  state: BriefCardState;
  brief: string | null;
  superseded: boolean;
  canStop: boolean;
  canRetry: boolean;
};

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
  const stopped = state === "stopped";
  return {
    state,
    brief: state === "ready" ? readHandoffBrief(turn) : null,
    superseded: stopped && !latest,
    canStop: state === "generating" && !stopping,
    canRetry: stopped && latest,
  };
}

const OPTIMISTIC_SEED_PREFIX = "optimistic-seed:";

type SeedSource = {
  sourceThreadId: string;
  sourceRef?: string | null;
  sourceTitle: string | null;
  cutoffTurnId: string;
};

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

export function isOptimisticSeed(turn: Turn): boolean {
  return turn.id.startsWith(OPTIMISTIC_SEED_PREFIX);
}
