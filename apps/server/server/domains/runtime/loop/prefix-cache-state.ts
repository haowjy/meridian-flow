/** Pure cache-warmth rule and repository-backed runtime service. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  ModelResponse,
  PrefixCachePredictionReason,
  PrefixCachePredictionState,
  Thread,
  Turn,
} from "@meridian/contracts/threads";
import {
  bakeIdAt,
  ForkCutoffOwnerNotFoundError,
  findCutoffOwnerThreadId,
  type ModelResponseRepository,
  type ThreadRepository,
  type TurnRepository,
} from "../../threads/index.js";
import type { ModelInfo, PromptCacheDescriptor } from "../gateway/index.js";
import { decodeImageInclusionMetadata } from "./image-context.js";

type CacheHistoryThread = Pick<
  Thread,
  "id" | "initialPromptBakeId" | "originType" | "originTurnId"
>;

export interface PrefixCacheHistory {
  thread: CacheHistoryThread;
  turns: readonly Turn[];
  responses: readonly Pick<ModelResponse, "turnId" | "sequence" | "model" | "requestStartedAt">[];
}

export type PrefixCacheStateReason = PrefixCachePredictionReason;

export interface PrefixCacheState {
  state: PrefixCachePredictionState;
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
  requestStartedAt: string | null;
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
  return latest
    ? { model: latest.model, requestStartedAt: latest.requestStartedAt, turn: latest.turn }
    : null;
}

function imageBreaksPrefix(turn: Turn): boolean {
  return (
    decodeImageInclusionMetadata(turn.metadata)?.breaks.some(
      (entry) => entry.reason === "budget_eviction" || entry.reason === "asset_unavailable",
    ) ?? false
  );
}

function boundaryAtOrAfterResponse(
  history: PrefixCacheHistory,
  response: LastResponse,
): PrefixCacheStateReason | null {
  const turns = [...history.turns].sort((left, right) => left.position - right.position);
  for (const turn of turns) {
    if (turn.status !== "complete") continue;
    if (turn.role === "compaction" && turn.position >= response.turn.position) return "compaction";
    if (turn.position > response.turn.position && imageBreaksPrefix(turn)) return "image_eviction";
  }
  return null;
}

function responseBakeChanged(history: PrefixCacheHistory, response: LastResponse): boolean {
  const latestTurn = [...history.turns]
    .sort((left, right) => left.position - right.position)
    .at(-1);
  const currentBake = latestTurn
    ? bakeIdAt(history.turns, latestTurn.id, history.thread.initialPromptBakeId)
    : history.thread.initialPromptBakeId;
  const responseBake = bakeIdAt(
    history.turns,
    response.turn.id,
    history.thread.initialPromptBakeId,
  );
  return responseBake !== currentBake;
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
  return sourceLatestTurn?.id === cutoffTurnId;
}

function forkBoundary(history: PrefixCacheHistory): PrefixCacheStateReason | null {
  const ordered = [...history.turns].sort((left, right) => left.position - right.position);
  for (const turn of ordered) {
    if (turn.status !== "complete") continue;
    if (turn.role === "compaction") return "compaction";
    if (imageBreaksPrefix(turn)) return "image_eviction";
  }
  return null;
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
    const latestForkTurn = [...history.turns]
      .sort((left, right) => left.position - right.position)
      .at(-1);
    const forkBakeId = latestForkTurn
      ? bakeIdAt(history.turns, latestForkTurn.id, history.thread.initialPromptBakeId)
      : history.thread.initialPromptBakeId;
    if (
      bakeIdAt(input.forkOwner.turns, cutoffTurnId, input.forkOwner.thread.initialPromptBakeId) !==
      forkBakeId
    ) {
      return cold("fork_bake_changed");
    }
    const boundary = forkBoundary(history);
    if (boundary) return cold(boundary);
    history = input.forkOwner;
    response = lastResponse(history);
  }

  if (!response) return cold("no_response");
  if (response.model !== input.model) return cold("model_changed");

  const boundary = boundaryAtOrAfterResponse(history, response);
  if (boundary) return cold(boundary);
  if (responseBakeChanged(history, response)) return cold("prompt_epoch");

  const ttlMs = input.promptCache.ttlMs;
  if (ttlMs === null) return cold("ttl_unknown");
  if (response.requestStartedAt === null) return cold("facts_unavailable");
  const responseTimeMs = Date.parse(response.requestStartedAt);
  if (!Number.isFinite(responseTimeMs) || !Number.isFinite(input.nowMs)) {
    return cold("facts_unavailable");
  }
  const ageMs = Math.max(0, input.nowMs - responseTimeMs);
  if (ageMs >= ttlMs) return cold("ttl_expired");

  return { state: "warm", reason: "reusable_prefix" };
}

export interface PrefixCacheStateServiceDeps {
  repos: {
    threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
    turns: Pick<TurnRepository, "findById" | "listByThread">;
    modelResponses: Pick<ModelResponseRepository, "findLatestByThread">;
  };
}

export interface PrefixCacheStateRequest {
  threadId: ThreadId;
  /** The model resolved during context assembly, including its cache descriptor. */
  model: ModelInfo | null;
  now?: Date | number;
}

/** Builds the repository-backed cache-state service for any runtime consumer. */
export function createPrefixCacheStateService(deps: PrefixCacheStateServiceDeps) {
  return {
    async prefixCacheStateFor(input: PrefixCacheStateRequest): Promise<PrefixCacheState> {
      const thread = await deps.repos.threads.findByIdIncludingDeleted(input.threadId);
      if (!thread || !input.model) return cold("facts_unavailable");

      const turns = await deps.repos.turns.listByThread(input.threadId);
      const latestResponse = await deps.repos.modelResponses.findLatestByThread(input.threadId);
      const history: PrefixCacheHistory = {
        thread,
        turns,
        responses: latestResponse ? [latestResponse] : [],
      };

      let forkOwner: PrefixCacheHistory | undefined;
      if (thread.originType === "fork" && !latestResponse) {
        let ownerThreadId: ThreadId;
        try {
          ownerThreadId = await findCutoffOwnerThreadId(thread, (turnId) =>
            deps.repos.turns.findById(turnId as Turn["id"]),
          );
        } catch (error) {
          if (error instanceof ForkCutoffOwnerNotFoundError) return cold("fork_cutoff");
          throw error;
        }
        const owner = await deps.repos.threads.findByIdIncludingDeleted(ownerThreadId);
        if (!owner) return cold("facts_unavailable");
        const ownerTurns = await deps.repos.turns.listByThread(ownerThreadId);
        const ownerResponse = await deps.repos.modelResponses.findLatestByThread(ownerThreadId);
        forkOwner = {
          thread: owner,
          turns: ownerTurns,
          responses: ownerResponse ? [ownerResponse] : [],
        };
      }

      const nowMs = input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now());
      return derivePrefixCacheState({
        model: input.model.id,
        promptCache: input.model.promptCache,
        nowMs,
        history,
        ...(forkOwner ? { forkOwner } : {}),
      });
    },
  };
}
