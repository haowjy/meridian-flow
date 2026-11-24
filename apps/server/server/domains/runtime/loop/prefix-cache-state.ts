import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  ModelResponse,
  PrefixCachePredictionReason,
  PrefixCachePredictionState,
  Thread,
  Turn,
} from "@meridian/contracts/threads";
import {
  type ModelInfo,
  type PromptCacheDescriptor,
  type PromptCacheRetention,
  resolvePromptCacheTtlSeconds,
} from "@meridian-flow/runtime/gateway";
import {
  bakeIdAt,
  decodeMediaInclusionMetadata,
  ForkCutoffOwnerNotFoundError,
  findCutoffOwnerThreadId,
  isPromptEpochMetadata,
  type ModelResponseRepository,
  type ThreadRepository,
  type TurnRepository,
} from "../../threads/index.js";
import { linkWindowAt } from "./media-link-window.js";

type CacheHistoryThread = Pick<
  Thread,
  "id" | "kind" | "initialPromptBakeId" | "originType" | "originTurnId"
>;

export function promptCacheRetentionFor(threadKind: Thread["kind"]): PromptCacheRetention {
  return threadKind === "subagent" ? "short" : "long";
}

function cacheTtlSeconds(
  promptCache: PromptCacheDescriptor | undefined,
  threadKind: Thread["kind"],
): number | null {
  return promptCache
    ? resolvePromptCacheTtlSeconds(promptCache, promptCacheRetentionFor(threadKind))
    : null;
}

const DEFAULT_LINK_WINDOW_SECONDS = 3600;

export function linkWindowSeconds(
  model: Pick<ModelInfo, "promptCache"> | null,
  threadKind: Thread["kind"],
  override?: number,
): number {
  return override ?? cacheTtlSeconds(model?.promptCache, threadKind) ?? DEFAULT_LINK_WINDOW_SECONDS;
}

export function cacheColdAt(
  model: Pick<ModelInfo, "promptCache"> | null,
  threadKind: Thread["kind"],
  requestStartMs: number,
): number | null {
  const ttl = cacheTtlSeconds(model?.promptCache, threadKind);
  return ttl === null ? null : requestStartMs + ttl * 1_000;
}

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
  nowMs: number;
  history: PrefixCacheHistory;
  mediaLinkWindowSeconds?: number;
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

function mediaBreaksPrefix(turn: Turn): boolean {
  return (
    decodeMediaInclusionMetadata(turn.metadata)?.breaks.some(
      (entry) => entry.reason === "budget_eviction" || entry.reason === "asset_unavailable",
    ) ?? false
  );
}

function boundaryReason(turn: Turn): PrefixCacheStateReason | null {
  if (turn.role === "compaction") return "compaction";
  if (isPromptEpochMetadata(turn.metadata)) return "prompt_epoch";

  if (mediaBreaksPrefix(turn)) return "media_eviction";
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

function unavailable(reason: PrefixCacheStateReason) {
  return { reason, response: null } as const;
}

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
  const selected = selectReusablePrefixResponse(input);
  if (!selected.response) return cold(selected.reason);
  const response = selected.response;
  if (cacheTtlSeconds(input.promptCache, input.history.thread.kind) === null)
    return cold("ttl_unknown");
  if (response.requestStartedAt === null) return cold("facts_unavailable");
  const responseTimeMs = Date.parse(response.requestStartedAt);
  if (!Number.isFinite(responseTimeMs) || !Number.isFinite(input.nowMs)) {
    return cold("facts_unavailable");
  }
  const coldAt = cacheColdAt(input, input.history.thread.kind, responseTimeMs);
  if (coldAt !== null && input.nowMs >= coldAt) return cold("ttl_expired");
  if (
    input.mediaLinkWindowSeconds !== undefined &&
    linkWindowAt(responseTimeMs, input.mediaLinkWindowSeconds).startMs !==
      linkWindowAt(input.nowMs, input.mediaLinkWindowSeconds).startMs
  ) {
    return cold("media_link_window");
  }

  return { state: "warm", reason: "reusable_prefix" };
}

export interface PrefixCacheStateServiceDeps {
  repos: {
    threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
    turns: Pick<TurnRepository, "findById" | "listByThread">;
    modelResponses: Pick<ModelResponseRepository, "findLatestByThread" | "findLatestForTurns">;
  };
}

export interface PrefixCacheStateRequest {
  threadId: ThreadId;
  throughTurnId?: TurnId;
  model: ModelInfo | null;
  now?: Date | number;
  knownLocalTurns?: readonly Turn[];
  mediaLinkWindowSeconds?: number;
}

export function createPrefixCacheStateService(deps: PrefixCacheStateServiceDeps) {
  async function readFacts(
    input: PrefixCacheStateRequest,
  ): Promise<DerivePrefixCacheStateInput | PrefixCacheState> {
    const thread = await deps.repos.threads.findByIdIncludingDeleted(input.threadId);
    if (!thread || !input.model) return cold("facts_unavailable");

    const [listedTurns, unboundedResponse] = await Promise.all([
      input.knownLocalTurns ?? deps.repos.turns.listByThread(input.threadId),
      input.throughTurnId ? null : deps.repos.modelResponses.findLatestByThread(input.threadId),
    ]);
    let turns = listedTurns;
    let latestResponse = unboundedResponse;
    if (input.throughTurnId) {
      const cutoffIndex = turns.findIndex((turn) => turn.id === input.throughTurnId);
      if (cutoffIndex < 0) return cold("fork_cutoff");
      turns = turns.slice(0, cutoffIndex + 1);
      latestResponse = await deps.repos.modelResponses.findLatestForTurns(
        turns.map((turn) => turn.id),
      );
    }
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
      const [ownerTurns, ownerResponse] = await Promise.all([
        deps.repos.turns.listByThread(ownerThreadId),
        deps.repos.modelResponses.findLatestByThread(ownerThreadId),
      ]);
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
      ...(input.mediaLinkWindowSeconds === undefined
        ? {}
        : { mediaLinkWindowSeconds: input.mediaLinkWindowSeconds }),
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
