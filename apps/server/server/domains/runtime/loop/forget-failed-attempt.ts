import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isClosingRow, retryTargetOf, type Turn } from "@meridian/contracts/threads";
import { deliveriesUnder, replyDrawsNothing } from "@meridian/thread-client/view";
import {
  type BlockRepository,
  CompactionMetadataCodec,
  type TurnRepository,
  toClientSafeBlock,
} from "../../threads/index.js";
import { turnGraph } from "../../threads/ports/turn-graph.js";
import { latestRowAt } from "./latest-row.js";

export interface AppendedTurns {
  closes: boolean;
  reservationExecutionId: string | null;
  retries: string | null;
}

export function appendedTurns(
  turns: ReadonlyArray<Pick<Turn, "role" | "origin" | "metadata" | "executionId">>,
): AppendedTurns {
  const reservation = turns.find(
    (turn) => (turn.role === "assistant" || turn.role === "compaction") && turn.executionId,
  );
  return {
    closes: turns.some(isClosingRow),
    reservationExecutionId: reservation?.executionId ?? null,
    retries:
      turns.map((turn) => retryTargetOf(turn as Turn)).find((target) => target !== null) ?? null,
  };
}

export interface AttemptMember {
  turn: Turn;
  delivered: readonly Turn[];
}

export interface ForgettingFacts {
  latest: Turn | null;
  failedSeeds: readonly Turn[];
  members: readonly AttemptMember[];
  answered: readonly Turn[];
  summaryProtectedWriterIds: ReadonlySet<string>;
}

export interface FailureEnd {
  turnId: string;
  end: "retried" | "forgotten" | "moved_on";
}

export interface ForgettingDecision {
  forget: readonly string[];
  ends: readonly FailureEnd[];
  reason: "retried" | "forgotten" | null;
}

const NOTHING: ForgettingDecision = { forget: [], ends: [], reason: null };

function isHandoffSeed(turn: Turn): boolean {
  const metadata = turn.metadata;
  return (
    turn.role === "system" &&
    !!metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    metadata.kind === "derivation_seed" &&
    metadata.derivation === "handoff"
  );
}

function isFailedAttemptTurn(turn: Turn): boolean {
  return turn.status === "error" && (turn.role === "assistant" || turn.role === "compaction");
}

export function decideForgetting(
  facts: ForgettingFacts,
  appended: AppendedTurns,
): ForgettingDecision {
  if (!appended.closes) return NOTHING;
  const seedEnds: FailureEnd[] = facts.failedSeeds.map((seed) => ({
    turnId: seed.id,
    end: "moved_on",
  }));
  const attempt = facts.members.map((member) => member.turn);
  const { latest } = facts;
  if (!latest || !isFailedAttemptTurn(latest) || attempt.length === 0)
    return { forget: [], ends: seedEnds, reason: null };
  const pending = facts.members.filter((member) => member.turn.forgottenBy == null);
  const latestEnds = (end: FailureEnd["end"]): FailureEnd[] =>
    latest.forgottenBy == null ? [{ turnId: latest.id, end }] : [];
  const kept = (): ForgettingDecision => ({
    forget: [],
    ends: [...seedEnds, ...latestEnds("moved_on")],
    reason: null,
  });
  if (latest.executionId && appended.reservationExecutionId === latest.executionId) return kept();
  if (pending.some((member) => member.turn.blocks.some((block) => block.blockType === "tool_use")))
    return kept();
  if (appended.retries === latest.id)
    return {
      forget: pending.map((member) => member.turn.id),
      ends: [...seedEnds, ...latestEnds("retried")],
      reason: "retried",
    };
  const drawsNothing = pending.every(
    (member) =>
      member.turn.role === "compaction" || replyDrawsNothing(member.turn, member.delivered),
  );
  if (!drawsNothing) return kept();
  const messages = facts.answered
    .filter((message) => !facts.summaryProtectedWriterIds.has(message.id))
    .map((message) => message.id);
  const forget = [...pending.map((member) => member.turn.id), ...messages];
  return forget.length === 0
    ? { forget, ends: [...seedEnds, ...latestEnds("moved_on")], reason: null }
    : { forget, ends: [...seedEnds, ...latestEnds("forgotten")], reason: "forgotten" };
}

export interface ForgettingDeps {
  turns: Pick<TurnRepository, "listMessageDeliveries"> & Parameters<typeof turnGraph>[0];
  blocks: Pick<BlockRepository, "listByTurnIds">;
}

export async function loadForgettingFacts(
  deps: ForgettingDeps,
  threadId: ThreadId,
  leaf: TurnId | null,
): Promise<ForgettingFacts> {
  const { latest, walkedOver } = await latestRowAt(deps.turns, leaf);
  const newestSeed = walkedOver.find(isHandoffSeed);
  const failedSeeds = newestSeed?.status === "error" ? [newestSeed] : [];
  const none: ForgettingFacts = {
    latest,
    failedSeeds,
    members: [],
    answered: [],
    summaryProtectedWriterIds: new Set(),
  };
  if (!latest || !isFailedAttemptTurn(latest)) return none;

  const graph = await turnGraph(deps.turns).listByThread(threadId);
  const byId = new Map(graph.map((turn) => [turn.id as string, turn]));
  const nextByPrev = new Map<string, Turn>();
  for (const turn of graph)
    if (turn.prevTurnId && !nextByPrev.has(turn.prevTurnId)) nextByPrev.set(turn.prevTurnId, turn);
  const reservationFor = new Map<string, Turn>();
  for (const turn of graph) {
    const metadata = turn.metadata;
    const replyId =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata.retryReplyId
        : undefined;
    if (typeof replyId === "string" && !reservationFor.has(replyId))
      reservationFor.set(replyId, turn);
  }

  const chain: Turn[] = [];
  const seen = new Set<string>();
  let cursor: Turn | undefined = byId.get(latest.id);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (isFailedAttemptTurn(cursor)) chain.push(cursor);
    const target = retryTargetOf(cursor);
    const next: Turn | undefined = target
      ? byId.get(target)
      : cursor.role === "assistant"
        ? reservationFor.get(cursor.id)
        : undefined;
    cursor = next && next.id !== cursor.id ? next : undefined;
  }

  const visitedBy = new Map<string, Turn[]>();
  for (const turn of chain) {
    if (turn.role !== "assistant") continue;
    const visited: Turn[] = [];
    deliveriesUnder(turn, nextByPrev, (next) => visited.push(next));
    visitedBy.set(turn.id, visited);
  }
  const wanted = new Map<string, Turn>();
  for (const turn of chain) if (turn.forgottenBy == null) wanted.set(turn.id, turn);
  for (const visited of visitedBy.values()) for (const turn of visited) wanted.set(turn.id, turn);
  const blocksByTurn = new Map<string, ReturnType<typeof toClientSafeBlock>[]>();
  for (const block of await deps.blocks.listByTurnIds([...wanted.keys()] as TurnId[])) {
    const list = blocksByTurn.get(block.turnId) ?? [];
    list.push(toClientSafeBlock(block));
    blocksByTurn.set(block.turnId, list);
  }
  const withBlocks = (turn: Turn): Turn => ({ ...turn, blocks: blocksByTurn.get(turn.id) ?? [] });
  const hydrated = new Map(nextByPrev);
  for (const turn of wanted.values())
    if (turn.prevTurnId && hydrated.get(turn.prevTurnId)?.id === turn.id)
      hydrated.set(turn.prevTurnId, withBlocks(turn));

  const members: AttemptMember[] = chain.map((turn) => ({
    turn: turn.forgottenBy == null ? withBlocks(turn) : { ...turn, blocks: [] },
    delivered: turn.role === "assistant" ? deliveriesUnder(turn, hydrated) : [],
  }));

  const memberIds = new Set(chain.map((turn) => turn.id));
  const deliveries = await deps.turns.listMessageDeliveries(threadId);
  const answered = graph.filter(
    (turn) =>
      turn.role === "user" &&
      turn.origin === "writer" &&
      turn.forgottenBy == null &&
      memberIds.has(deliveries.get(turn.id)?.byTurnId ?? ""),
  );
  return {
    latest,
    failedSeeds,
    members,
    answered,
    summaryProtectedWriterIds: summaryProtected(graph, byId, answered),
  };
}

function summaryProtected(
  graph: readonly Turn[],
  byId: ReadonlyMap<string, Turn>,
  candidates: readonly Turn[],
): ReadonlySet<string> {
  const protectedIds = new Set<string>();
  if (candidates.length === 0) return protectedIds;
  for (const turn of graph) {
    if (turn.role !== "compaction" || turn.status !== "complete") continue;
    const parsed = CompactionMetadataCodec.safeParse(turn.metadata);
    if (!parsed.success || !parsed.data.compactedThrough) continue;
    const cut = byId.get(parsed.data.compactedThrough.turnId);
    if (!cut) continue;
    const pins = new Set(parsed.data.pinnedRequestTurnIds ?? []);
    for (const message of candidates)
      if (message.position <= cut.position && !pins.has(message.id)) protectedIds.add(message.id);
  }
  return protectedIds;
}
