/** Pure cache-warmth rule and repository-backed runtime service. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  ModelResponse,
  PrefixCachePredictionReason,
  PrefixCachePredictionState,
  Thread,
  Turn,
} from "@meridian/contracts/threads";
import {
  bakeIdAt,
  decodeImageInclusionMetadata,
  ForkCutoffOwnerNotFoundError,
  findCutoffOwnerThreadId,
  isPromptEpochMetadata,
  type ModelResponseRepository,
  type ThreadRepository,
  type TurnRepository,
} from "../../threads/index.js";
import type { ModelInfo, PromptCacheDescriptor } from "../gateway/index.js";

type CacheHistoryThread = Pick<
  Thread,
  "id" | "initialPromptBakeId" | "originType" | "originTurnId"
>;

export interface PrefixCacheHistory {
  thread: CacheHistoryThread;
  turns: readonly Turn[];
  responses: readonly Pick<
    ModelResponse,
    "turnId" | "sequence" | "model" | "requestStartedAt" | "inputTokens" | "requestMessageCount"
  >[];
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
  inputTokens: number;
  requestMessageCount: number;
  model: string;
  requestStartedAt: string | null;
  turn: Turn;
};

function lastResponse(history: PrefixCacheHistory): LastResponse | null {
  const turnsById = new Map(history.turns.map((turn) => [turn.id, turn]));
  const responses = history.responses.flatMap((response) => {
    const turn = turnsById.get(response.turnId);
    return turn && turn.role === "assistant" ? [{ ...response, turn }] : [];
  });
  responses.sort(
    (left, right) => left.turn.position - right.turn.position || left.sequence - right.sequence,
  );
  const latest = responses.at(-1);
  return latest ? { ...latest, turn: latest.turn } : null;
}

function imageBreaksPrefix(turn: Turn): boolean {
  return (
    decodeImageInclusionMetadata(turn.metadata)?.breaks.some(
      (entry) => entry.reason === "budget_eviction" || entry.reason === "asset_unavailable",
    ) ?? false
  );
}

function boundaryReason(turn: Turn): PrefixCacheStateReason | null {
  if (turn.role === "compaction") return "compaction";
  if (isPromptEpochMetadata(turn.metadata)) return "prompt_epoch";

  if (imageBreaksPrefix(turn)) return "image_eviction";
  return null;
}

function boundaryAtOrAfterResponse(
  history: PrefixCacheHistory,
  response: LastResponse,
): PrefixCacheStateReason | null {
  const turns = [...history.turns].sort((left, right) => left.position - right.position);
  for (const turn of turns) {
    if (turn.status !== "complete") continue;
    if (turn.role === "compaction" && turn.position >= response.turn.position) return "compaction";
    if (turn.position > response.turn.position) {
      const boundary = boundaryReason(turn);
      if (boundary) return boundary;
    }
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

function isForkCutoffCurrent(history: PrefixCacheHistory, cutoffTurnId: string): boolean {
  const latest = [...history.turns].sort((a, b) => a.position - b.position).at(-1);
  return latest?.id === cutoffTurnId && latest.threadId === history.thread.id;
}

function forkBoundary(history: PrefixCacheHistory): PrefixCacheStateReason | null {
  const ordered = [...history.turns].sort((left, right) => left.position - right.position);
  for (const turn of ordered) {
    if (turn.status !== "complete") continue;
    if (turn.role === "compaction") return "compaction";
    const boundary = boundaryReason(turn);
    if (boundary) return boundary;
  }
  return null;
}

function cold(reason: PrefixCacheStateReason): PrefixCacheState {
  return { state: "cold", reason };
}

/** Predicts prefix warmth from durable thread, turn, and response facts only. */
function unavailable(reason: PrefixCacheStateReason) {
  return { reason, response: null } as const;
}

/** The shared reusable-prefix selection. TTL affects warmth, never the token baseline. */
export function selectReusablePrefixResponse(input: DerivePrefixCacheStateInput) {
  let history = input.history;
  let response = lastResponse(history);
  if (!response) {
    const boundary = forkBoundary(history);
    if (boundary) return unavailable(boundary);
  }
  if (!response && history.thread.originType === "fork") {
    if (
      !input.forkOwner ||
      !history.thread.originTurnId ||
      !isForkCutoffCurrent(input.forkOwner, history.thread.originTurnId)
    )
      return unavailable("fork_cutoff");
    const cutoffTurnId = history.thread.originTurnId;
    if (!cutoffTurnId || !input.forkOwner) return unavailable("fork_cutoff");
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
      return unavailable("fork_bake_changed");
    }
    const boundary = forkBoundary(history);
    if (boundary) return unavailable(boundary);
    history = input.forkOwner;
    response = lastResponse(history);
  }

  if (!response) return unavailable("no_response");
  const boundary = boundaryAtOrAfterResponse(history, response);
  if (boundary) return unavailable(boundary);
  if (response.model !== input.model) return unavailable("model_changed");
  if (responseBakeChanged(history, response)) return unavailable("prompt_epoch");

  return { response, reason: "reusable_prefix" as const };
}

export function derivePrefixCacheState(input: DerivePrefixCacheStateInput): PrefixCacheState {
  if (input.promptCache.kind === "none") return cold("uncached");
  const selected = selectReusablePrefixResponse(input);
  if (!selected.response) return cold(selected.reason);
  const response = selected.response;
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
  throughTurnId?: TurnId;
  /** The model resolved during context assembly, including its cache descriptor. */
  model: ModelInfo | null;
  now?: Date | number;
  knownLocalTurns?: readonly Turn[];
}

/** Builds the repository-backed cache-state service for any runtime consumer. */
export function createPrefixCacheStateService(deps: PrefixCacheStateServiceDeps) {
  async function readFacts(
    input: PrefixCacheStateRequest,
  ): Promise<DerivePrefixCacheStateInput | PrefixCacheState> {
    const thread = await deps.repos.threads.findByIdIncludingDeleted(input.threadId);
    if (!thread || !input.model) return cold("facts_unavailable");

    const turns = input.knownLocalTurns ?? (await deps.repos.turns.listByThread(input.threadId));
    const latestResponse = await deps.repos.modelResponses.findLatestByThread(input.threadId);
    const history: PrefixCacheHistory = {
      thread,
      turns,
      responses: latestResponse ? [latestResponse] : [],
    };

    if (input.throughTurnId && !isForkCutoffCurrent(history, input.throughTurnId)) {
      return cold("fork_cutoff");
    }

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
    return {
      model: input.model.id,
      promptCache: input.model.promptCache,
      nowMs,
      history,
      ...(forkOwner ? { forkOwner } : {}),
    };
  }
  return {
    async prefixCacheStateFor(input: PrefixCacheStateRequest): Promise<PrefixCacheState> {
      const facts = await readFacts(input);
      return "state" in facts ? facts : derivePrefixCacheState(facts);
    },
    async reusableResponseFor(input: PrefixCacheStateRequest) {
      const facts = await readFacts(input);
      if ("state" in facts) return null;
      const { response } = selectReusablePrefixResponse(facts);
      return response && response.inputTokens > 0
        ? { inputTokens: response.inputTokens, messageCount: response.requestMessageCount }
        : null;
    },
  };
}
