/**
 * Pure reads of a handoff seed S: the destination's first system turn, which
 * the runtime completes with the brief (or its unavailable fallback).
 *
 * The server's `HandoffSeedMetadataCodec` owns the shape; the client picks the
 * fields the writer sees and reads them defensively.
 */
import type { Turn } from "@meridian/contracts/protocol";
import type { ThreadPhase } from "@meridian/contracts/threads";

export type HandoffSeedFacts = {
  sourceThreadId: string;
  sourceRef: string | null;
  /**
   * The source's title when S was created, for display only: it names a
   * source the writer can no longer read (in the trash). Null when the
   * source was untitled.
   */
  sourceTitle: string | null;
  cutoffTurnId: string | null;
  /** The `handoff_brief` control this seed answers. */
  controlMessageId: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The seed's facts, or null when the turn is not a handoff seed. */
export function readHandoffSeed(turn: Turn): HandoffSeedFacts | null {
  if (turn.role !== "system") return null;
  const metadata = record(turn.metadata);
  if (metadata?.kind !== "derivation_seed" || metadata.derivation !== "handoff") return null;
  const sourceThreadId = text(metadata.sourceThreadId);
  if (!sourceThreadId) return null;
  return {
    sourceThreadId,
    sourceRef: text(metadata.sourceRef),
    sourceTitle: text(metadata.sourceTitle),
    cutoffTurnId: text(metadata.cutoffTurnId),
    controlMessageId: text(metadata.controlMessageId),
  };
}

export function isHandoffSeed(turn: Turn): boolean {
  return readHandoffSeed(turn) !== null;
}

/** The brief text from the completed seed's `handoff-brief` block. */
export function readHandoffBrief(turn: Turn): string | null {
  for (const block of turn.blocks ?? []) {
    if (block.blockType !== "custom") continue;
    const content = record(block.content);
    if (content?.kind !== "handoff-brief") continue;
    const props = record(content.props);
    return props?.state === "available" ? text(props.brief) : null;
  }
  return null;
}

export type BriefCardState = "generating" | "ready" | "failed" | "stopped";

export type BriefCardView = {
  state: BriefCardState;
  brief: string | null;
  /**
   * Writer copy for the latest seed's failure (its `turn.error`, which asks
   * the writer to try again); null otherwise.
   */
  failureCopy: string | null;
  /** An ended brief a newer seed has replaced: its story is told, with nothing to act on. */
  superseded: boolean;
  /** Stop is offered while the brief is generating and no Stop is in flight. */
  canStop: boolean;
  /** Retry is offered only on the latest seed, once it ended without a brief. */
  canRetry: boolean;
  /** The runtime has bound the brief to a run (`briefing`), rather than it waiting to start. */
  running: boolean;
};

/**
 * One brief card's view state. `latest` is whether this is the thread's newest
 * seed; `retryPending` is whether a Retry is already queued or on its way (the
 * server refuses a second while one waits).
 */
export function briefCardView(input: {
  turn: Turn;
  latest: boolean;
  retryPending: boolean;
  stopping: boolean;
  phase: ThreadPhase | null;
}): BriefCardView {
  const { turn, latest, retryPending, stopping, phase } = input;
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
    failureCopy: state === "failed" && latest ? (turn.error ?? null) : null,
    superseded: ended && !latest,
    canStop: state === "generating" && !stopping,
    canRetry: ended && latest && !retryPending,
    running: state === "generating" && phase === "briefing",
  };
}

const OPTIMISTIC_SEED_PREFIX = "optimistic-seed:";

/**
 * The seed a handoff shows before the server has created it: the brief is
 * already on its way, so the card says so at once. It has no turn to stop yet.
 */
export function optimisticHandoffSeed(input: {
  threadId: string;
  sourceThreadId: string;
  sourceTitle: string | null;
  cutoffTurnId: string;
  createdAt: string;
}): Turn {
  return {
    id: `${OPTIMISTIC_SEED_PREFIX}${input.threadId}`,
    threadId: input.threadId,
    position: 1,
    prevTurnId: null,
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
      sourceTitle: input.sourceTitle,
      cutoffTurnId: input.cutoffTurnId,
    },
    createdAt: input.createdAt,
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

export function isOptimisticSeed(turn: Turn): boolean {
  return turn.id.startsWith(OPTIMISTIC_SEED_PREFIX);
}
