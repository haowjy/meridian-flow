/** Pure read model for whether a stored conversation prefix is likely cached. */

import type { ModelResponse, Thread, Turn } from "@meridian/contracts/threads";
import type { PromptCacheDescriptor } from "../gateway/index.js";

type CacheHistoryThread = Pick<
  Thread,
  "id" | "initialPromptBakeId" | "originType" | "originTurnId"
>;

export interface PrefixCacheHistory {
  thread: CacheHistoryThread;
  turns: readonly Turn[];
  responses: readonly Pick<ModelResponse, "turnId" | "sequence" | "model" | "createdAt">[];
}

export type PrefixCacheStateReason =
  | "reusable_prefix"
  | "uncached"
  | "no_response"
  | "model_changed"
  | "prompt_epoch"
  | "image_eviction"
  | "compaction"
  | "ttl_unknown"
  | "ttl_expired"
  | "fork_cutoff"
  | "fork_bake_changed"
  | "facts_unavailable";

export interface PrefixCacheState {
  state: "warm" | "cold";
  reason: PrefixCacheStateReason;
}

export interface DerivePrefixCacheStateInput {
  model: string;
  promptCache: PromptCacheDescriptor;
  /** Current time in Unix milliseconds, supplied by the caller for purity. */
  nowMs: number;
  history: PrefixCacheHistory;
  /** The owner history for a fork's originTurnId, needed only before its first local response. */
  forkOwner?: PrefixCacheHistory;
}

type LastResponse = {
  model: string;
  createdAt: string;
  turn: Turn;
};

function lastResponse(history: PrefixCacheHistory): LastResponse | null {
  const turnsById = new Map(history.turns.map((turn) => [turn.id, turn]));
  const responses = history.responses.flatMap((response) => {
    const turn = turnsById.get(response.turnId);
    return turn ? [{ ...response, turn }] : [];
  });
  responses.sort(
    (left, right) => left.turn.position - right.turn.position || left.sequence - right.sequence,
  );
  const latest = responses.at(-1);
  return latest ? { model: latest.model, createdAt: latest.createdAt, turn: latest.turn } : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundaryReason(turn: Turn): PrefixCacheStateReason | null {
  if (turn.role === "compaction") return "compaction";

  const metadata = objectValue(turn.metadata);
  if (
    metadata?.kind === "prompt_epoch_boundary" ||
    (metadata && objectValue(metadata.promptEpoch))
  ) {
    return "prompt_epoch";
  }

  const imageUpdate = metadata?.kind === "system_update" && metadata.section === "image_inclusion";
  const breaks = imageUpdate && Array.isArray(metadata.breaks) ? metadata.breaks : [];
  if (
    breaks.some((entry) => {
      const reason = objectValue(entry)?.reason;
      return reason === "budget_eviction" || reason === "asset_unavailable";
    })
  ) {
    return "image_eviction";
  }
  return null;
}

function boundaryAfterResponse(
  history: PrefixCacheHistory,
  response: LastResponse,
): PrefixCacheStateReason | null {
  const turnsAfterResponse = [...history.turns]
    .filter((turn) => turn.position > response.turn.position)
    .sort((left, right) => left.position - right.position);
  for (const turn of turnsAfterResponse) {
    const reason = boundaryReason(turn);
    if (reason) return reason;
  }
  return null;
}

function effectiveBakeIdAt(history: PrefixCacheHistory, turnId: string): string | null | undefined {
  const turns = [...history.turns].sort((left, right) => left.position - right.position);
  const cutoffIndex = turns.findIndex((turn) => turn.id === turnId);
  if (cutoffIndex < 0) return undefined;
  const boundary = [...turns.slice(0, cutoffIndex + 1)]
    .reverse()
    .find((turn) => turn.status === "complete" && turn.promptBakeId !== null);
  return boundary?.promptBakeId ?? history.thread.initialPromptBakeId;
}

function currentBakeId(history: PrefixCacheHistory): string | null {
  const boundary = [...history.turns]
    .sort((left, right) => left.position - right.position)
    .reverse()
    .find((turn) => turn.status === "complete" && turn.promptBakeId !== null);
  return boundary?.promptBakeId ?? history.thread.initialPromptBakeId;
}

function isForkCutoffCurrent(input: DerivePrefixCacheStateInput): boolean {
  const { history, forkOwner } = input;
  const cutoffTurnId = history.thread.originTurnId;
  if (!cutoffTurnId || !forkOwner) return false;
  const cutoffTurn = forkOwner.turns.find((turn) => turn.id === cutoffTurnId);
  if (!cutoffTurn || cutoffTurn.threadId !== forkOwner.thread.id) return false;
  const sourceLatestTurn = [...forkOwner.turns]
    .sort((left, right) => left.position - right.position)
    .at(-1);
  if (sourceLatestTurn?.id !== cutoffTurnId) return false;
  return true;
}

function cold(reason: PrefixCacheStateReason): PrefixCacheState {
  return { state: "cold", reason };
}

/** Predicts prefix warmth from durable thread, turn, and response facts only. */
export function derivePrefixCacheState(input: DerivePrefixCacheStateInput): PrefixCacheState {
  if (input.promptCache.kind === "none") return cold("uncached");

  let history = input.history;
  let response = lastResponse(history);
  if (!response && history.thread.originType === "fork") {
    if (!isForkCutoffCurrent(input)) return cold("fork_cutoff");
    const cutoffTurnId = history.thread.originTurnId;
    if (!cutoffTurnId || !input.forkOwner) return cold("fork_cutoff");
    const forkBakeId = currentBakeId(history);
    const sourceBakeId = effectiveBakeIdAt(input.forkOwner, cutoffTurnId);
    if (sourceBakeId === undefined || sourceBakeId !== forkBakeId) {
      return cold("fork_bake_changed");
    }
    history = input.forkOwner;
    response = lastResponse(history);
    const forkBoundary = [...input.history.turns]
      .sort((left, right) => left.position - right.position)
      .map(boundaryReason)
      .find((reason) => reason !== null);
    if (forkBoundary) return cold(forkBoundary);
  }

  if (!response) return cold("no_response");
  if (response.model !== input.model) return cold("model_changed");

  const boundary = boundaryAfterResponse(history, response);
  if (boundary) return cold(boundary);

  const ttlMs = input.promptCache.ttlMs;
  if (ttlMs === null) return cold("ttl_unknown");
  const responseTimeMs = Date.parse(response.createdAt);
  if (!Number.isFinite(responseTimeMs) || input.nowMs < responseTimeMs) {
    return cold("ttl_expired");
  }
  if (input.nowMs - responseTimeMs >= ttlMs) return cold("ttl_expired");

  return { state: "warm", reason: "reusable_prefix" };
}
