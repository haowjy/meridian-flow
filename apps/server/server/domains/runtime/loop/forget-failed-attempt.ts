/**
 * Forgetting a failed attempt: the one rule for which turns leave the conversation when the writer retries
 * a failed reply or the chat moves past it, and the loader that gathers the facts it reads.
 *
 * `decideForgetting` is pure. `loadForgettingFacts` builds its input, and run start and the append
 * primitive both use it, so the request is built over the history the commit will leave. The rule and its
 * steps are in design-fx.md (F1); a step number in a comment below names one of them.
 */
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

/** What the appended turns say about the boundary, derived the same way at run start and in the primitive. */
export interface AppendedTurns {
  /** At least one appended turn is a closing row. */
  closes: boolean;
  /** The execution id of the appended reservation (an assistant or compaction turn), or null. */
  reservationExecutionId: string | null;
  /** The failed reply an appended turn retries (`metadata.retryOf`), or null. */
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

/** One turn of the failed attempt, with the content the client sees and the deliveries grouped under it. */
export interface AttemptMember {
  turn: Turn;
  /** `subagent_update` turns grouped under the member, as the view groups them. */
  delivered: readonly Turn[];
}

export interface ForgettingFacts {
  /** The latest row, or null when the walk reached the root. */
  latest: Turn | null;
  /** Failed handoff seeds walked over to reach it (step 9). */
  failedSeeds: readonly Turn[];
  /** The failed attempt, newest first, when `latest` is a settled failed reply or compaction; else empty. */
  members: readonly AttemptMember[];
  /** Writer messages delivered to any member that are not forgotten yet. */
  answered: readonly Turn[];
  /** Writer messages a complete compaction covers by its cut without pinning them. */
  summaryProtectedWriterIds: ReadonlySet<string>;
}

export interface ForgettingDecision {
  /** Turn ids to stamp, the attempt first. */
  forget: readonly string[];
  /** Failed turns whose card ends without being forgotten: a kept attempt, a continuation, or a failed seed. */
  passed: readonly string[];
  reason: "retried" | "forgotten" | null;
}

const NOTHING: ForgettingDecision = { forget: [], passed: [], reason: null };

function isFailedSeed(turn: Turn): boolean {
  const metadata = turn.metadata;
  return (
    turn.role === "system" &&
    turn.status === "error" &&
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
  // 1. No closing row appended: the boundary doesn't end anything.
  if (!appended.closes) return NOTHING;
  // 9. A failed seed's failure ends here whatever follows; its model text states a fact, so it is never forgotten.
  const passed: string[] = facts.failedSeeds.map((seed) => seed.id);
  const attempt = facts.members.map((member) => member.turn);
  const { latest } = facts;
  // 2. Only the latest row, when it is a settled failed reply or compaction, can be forgotten.
  if (!latest || !isFailedAttemptTurn(latest) || attempt.length === 0)
    return { forget: [], passed, reason: null };
  const pending = facts.members.filter((member) => member.turn.forgottenBy == null);
  const ends = (): ForgettingDecision => ({
    forget: [],
    passed: [...passed, ...pending.map((member) => member.turn.id)],
    reason: null,
  });
  // 3. Continuation: the same execution carries on past the failure. A null id never matches.
  if (latest.executionId && appended.reservationExecutionId === latest.executionId) return ends();
  // 5. Tool calls stay: a write may have landed, and the model keeps the call and its result.
  if (pending.some((member) => member.turn.blocks.some((block) => block.blockType === "tool_use")))
    return ends();
  // 6. Retry: forget the failed attempt; its messages stay, because the Retry answers them.
  if (appended.retries === latest.id)
    return { forget: pending.map((member) => member.turn.id), passed, reason: "retried" };
  // 7. Moving on: forget the attempt and the messages it answered, but only if it drew nothing. A compaction
  // draws nothing but its failure; an already-forgotten member counts as drawing nothing.
  const drawsNothing = pending.every(
    (member) =>
      member.turn.role === "compaction" || replyDrawsNothing(member.turn, member.delivered),
  );
  if (!drawsNothing) return ends();
  const messages = facts.answered
    .filter((message) => !facts.summaryProtectedWriterIds.has(message.id))
    .map((message) => message.id);
  const forget = [...pending.map((member) => member.turn.id), ...messages];
  return forget.length === 0
    ? { forget, passed, reason: null }
    : { forget, passed, reason: "forgotten" };
}

export interface ForgettingDeps {
  turns: Pick<TurnRepository, "listMessageDeliveries"> & Parameters<typeof turnGraph>[0];
  blocks: Pick<BlockRepository, "listByTurnIds">;
}

/** Gathers the facts `decideForgetting` reads, from the graph at `leaf`. Cheap unless the latest row failed. */
export async function loadForgettingFacts(
  deps: ForgettingDeps,
  threadId: ThreadId,
  leaf: TurnId | null,
): Promise<ForgettingFacts> {
  const { latest, walkedOver } = await latestRowAt(deps.turns, leaf);
  const failedSeeds = walkedOver.filter(isFailedSeed);
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
  // A Retry led by a compaction carries `retryOf` on the compaction; the reply it answers only appears
  // in the compaction's `retryReplyId`.
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
    // A completed Retry-led compaction is not a member: its summary is content.
    if (isFailedAttemptTurn(cursor)) chain.push(cursor);
    const target = retryTargetOf(cursor);
    const next: Turn | undefined = target
      ? byId.get(target)
      : cursor.role === "assistant"
        ? reservationFor.get(cursor.id)
        : undefined;
    cursor = next && next.id !== cursor.id ? next : undefined;
  }

  // The delivery walk stops at the view's next row, and whether a turn is one reads its blocks (a child
  // seed's thread references, an overflow shell's emptiness). Graph rows carry none, so a dry walk per
  // assistant member finds the turns it visits, then one read loads the blocks of those and of the
  // members, and the real walks run over one shared index. Hydration can only add an earlier stop, never
  // remove the one the dry walk found, so the dry walk visits a sufficient superset.
  const visitedBy = new Map<string, Turn[]>();
  for (const turn of chain) {
    if (turn.role !== "assistant") continue;
    const visited: Turn[] = [];
    deliveriesUnder(turn, nextByPrev, (next) => visited.push(next));
    visitedBy.set(turn.id, visited);
  }
  // An already-forgotten member counts as drawing nothing, so its content is read only if a walk visits it.
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
