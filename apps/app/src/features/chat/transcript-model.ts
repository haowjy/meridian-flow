/** One indexed interpretation of transcript rows, response boundaries, delivery rows, and reveal targets. */
import { parseInvocationCard } from "@meridian/contracts/components";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/protocol";
import {
  type CompactionUndoMarkers,
  collectUndoMarkers,
  isOverflowShell,
  NO_UNDO_MARKERS,
  readCompactionFacts,
  undoMarkerTarget,
} from "./compaction/compaction-model";
import { isHandoffSeed } from "./derivation/handoff-seed";
import { reportPersistedContractFailure } from "./persisted-contract-debug";
import { readSubagentUpdateMetadata } from "./subagent/update";

export type TurnClass = "bubble" | "delivery" | "context" | "plumbing";
const emptyEvents: DeliveryEvent[] = [];
export type DeliveryEvent = {
  turn: Turn;
  childThreadId?: string;
  agentName?: string;
  title?: string;
  subagentUpdate: ReturnType<typeof readSubagentUpdateMetadata>;
};

/**
 * A fork's frozen prefix: the source's turns through the cutoff, read from the
 * inherited transcript range. Each turn names its owner, which is the fork's
 * source or, for a fork of a fork, a thread further up.
 */
export type InheritedTranscript = {
  turns: readonly Turn[];
  ownerByTurnId: ReadonlyMap<string, string>;
};

/** Marks a row the fork inherited. Local rows carry null. */
export type InheritedMark = {
  ownerThreadId: string;
  /** First row of a run from this owner: where "From <source>" goes. */
  startsOwner: boolean;
  /** Last inherited row: the fork point, below which the fork's own turns begin. */
  endsInherited: boolean;
};

/**
 * One rendered transcript row. Every row carries its turn, so `visibleTurns`
 * stays index-aligned with `rows` (reveal landing and the virtual list read
 * both); response grouping walks rows and switches on `kind`, never on role.
 * The conversational head keeps its own policy (`classifyTurn`).
 */
export type TranscriptRow =
  | { kind: "turn"; turn: Turn; inherited: InheritedMark | null }
  | {
      kind: "compaction";
      turn: Turn;
      undo: CompactionUndoMarkers;
      inherited: InheritedMark | null;
    }
  /** A handoff seed S: the brief card. Only the newest local seed can be retried. */
  | { kind: "handoff-seed"; turn: Turn; latest: boolean; inherited: InheritedMark | null };

export function classifyTurn(turn: Turn): TurnClass {
  const metadata =
    turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
      ? turn.metadata
      : null;
  if (turn.role === "compaction") return "plumbing";
  if (turn.role === "assistant") return "bubble";
  if (metadata?.kind === "inbox_message" || metadata?.kind === "subagent_update") return "delivery";
  if (
    turn.role === "user" &&
    metadata?.kind === "system_update" &&
    metadata.section === "work_context"
  )
    return "context";
  if (turn.role === "user") return "bubble";
  return turn.blocks.some((block) => block.blockType === "custom") ? "bubble" : "plumbing";
}

export function buildTranscriptModel(
  localTurns: Turn[],
  awaitingSubagents: boolean,
  inherited: InheritedTranscript | null = null,
) {
  const turns = inherited?.turns.length ? [...inherited.turns, ...localTurns] : localTurns;
  const nextByPrev = new Map<string, Turn>();
  for (const turn of turns) if (turn.prevTurnId) nextByPrev.set(turn.prevTurnId, turn);
  const undoByCompactionId = collectUndoMarkers(turns);
  const rows: TranscriptRow[] = [];
  let latestSeedIndex = -1;
  turns.forEach((turn, index) => {
    const owner = inherited?.ownerByTurnId.get(turn.id) ?? null;
    const mark: InheritedMark | null = owner
      ? { ownerThreadId: owner, startsOwner: false, endsInherited: false }
      : null;
    if (turn.role === "compaction") {
      rows.push({
        kind: "compaction",
        turn,
        undo: undoByCompactionId.get(turn.id) ?? NO_UNDO_MARKERS,
        inherited: mark,
      });
      return;
    }
    // A fork of a handoff destination inherits its brief, read-only.
    if (isHandoffSeed(turn)) {
      if (!mark) latestSeedIndex = rows.length;
      rows.push({ kind: "handoff-seed", turn, latest: false, inherited: mark });
      return;
    }
    // An undo marker renders on the divider it names, never as its own row.
    if (undoMarkerTarget(turn)) return;
    if (isOverflowShell(turn, nextByPrev.get(turn.id) ?? turns[index + 1])) return;
    if (classifyTurn(turn) === "bubble") rows.push({ kind: "turn", turn, inherited: mark });
  });
  const latestSeed = rows[latestSeedIndex];
  if (latestSeed?.kind === "handoff-seed") rows[latestSeedIndex] = { ...latestSeed, latest: true };
  markInheritedRuns(rows);
  // Index-aligned with `rows`: response grouping and reveal landing read turns.
  const visibleTurns = rows.map((row) => row.turn);
  const subagentUpdateByTurnId = new Map<string, ReturnType<typeof readSubagentUpdateMetadata>>();
  const invocationByExecution = new Map<
    string,
    { threadId?: string; agentName: string; title?: string }
  >();
  for (const turn of turns) {
    const metadata =
      turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
        ? (turn.metadata as Record<string, unknown>)
        : null;
    if (metadata?.kind === "subagent_update") {
      const update = readSubagentUpdateMetadata(metadata);
      subagentUpdateByTurnId.set(turn.id, update);
      if (!update) {
        reportPersistedContractFailure({
          contract: "subagent_update",
          turnId: turn.id,
        });
      }
    }
    for (const block of turn.blocks ?? []) {
      const content =
        block.content && typeof block.content === "object" && !Array.isArray(block.content)
          ? (block.content as Record<string, unknown>)
          : null;
      if (content?.kind !== "helper-result") continue;
      const card = parseInvocationCard(block.content);
      if (!card) {
        reportPersistedContractFailure({
          contract: "invocation_card",
          turnId: turn.id,
          blockId: block.id,
        });
      } else if (card.execution) {
        invocationByExecution.set(card.execution, {
          ...(card.childThreadId ? { threadId: card.childThreadId } : {}),
          agentName: card.agentName,
          ...(card.title ? { title: card.title } : {}),
        });
      }
    }
  }

  const deliveryEventsByAssistantTurnId = new Map<string, DeliveryEvent[]>();
  const latestRevealTurnByChildThreadId = new Map<string, string>();
  const rowTurnIds = new Set(visibleTurns.map((turn) => turn.id));
  for (const turn of visibleTurns) {
    if (turn.role !== "assistant") continue;
    const events: DeliveryEvent[] = [];
    let cursor = turn.id;
    const seen = new Set<string>();
    while (true) {
      const next = nextByPrev.get(cursor);
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      // Delivery events belong to the reply until the next rendered row
      // (a writer turn, another reply, a divider, or a brief card).
      if (rowTurnIds.has(next.id)) break;
      if (classifyTurn(next) === "delivery" && next.role === "system") {
        const update = subagentUpdateByTurnId.get(next.id) ?? null;
        const invocation = update?.execution
          ? invocationByExecution.get(update.execution)
          : undefined;
        const childThreadId = update?.childThreadId ?? invocation?.threadId;
        events.push({
          turn: next,
          subagentUpdate: update,
          ...(childThreadId ? { childThreadId } : {}),
          ...(update?.agentName || invocation?.agentName
            ? { agentName: update?.agentName ?? invocation?.agentName }
            : {}),
          ...(invocation?.title ? { title: invocation.title } : {}),
        });
        if (childThreadId) latestRevealTurnByChildThreadId.set(childThreadId, turn.id);
      }
      cursor = next.id;
    }
    if (events.length) deliveryEventsByAssistantTurnId.set(turn.id, events);
  }

  const { partsByFinalTurnId, continuing } = responseGroups(rows, awaitingSubagents);
  return {
    rows,
    visibleTurns,
    deliveryEventsByAssistantTurnId,
    invocationByExecution,
    latestRevealTurnByChildThreadId,
    continuing,
    partsByFinalTurnId,
    deliveryEventsFor: (turnId: string) =>
      deliveryEventsByAssistantTurnId.get(turnId) ?? emptyEvents,
    resolveRevealTurnId: (childThreadId: string, originTurnId: string) =>
      latestRevealTurnByChildThreadId.get(childThreadId) ?? originTurnId,
  };
}

/** Marks where each owner's run of inherited rows starts, and where the fork's own rows begin. */
function markInheritedRuns(rows: TranscriptRow[]) {
  let lastInherited = -1;
  rows.forEach((row, index) => {
    if (!row.inherited) return;
    lastInherited = index;
    const previous = rows[index - 1]?.inherited ?? null;
    if (previous?.ownerThreadId !== row.inherited.ownerThreadId)
      rows[index] = { ...row, inherited: { ...row.inherited, startsOwner: true } };
  });
  const last = rows[lastInherited];
  if (last?.inherited)
    rows[lastInherited] = { ...last, inherited: { ...last.inherited, endsInherited: true } };
}

function ownerOf(row: TranscriptRow | undefined): string | null {
  return row?.inherited?.ownerThreadId ?? null;
}

function responseGroups(rows: readonly TranscriptRow[], awaitingSubagents: boolean) {
  const groups = new Map<string, readonly Turn[]>();
  const continuing = Array.from({ length: rows.length }, () => false);
  let parts: Turn[] = [];
  const finish = () => {
    const end = parts.at(-1);
    if (end) groups.set(end.id, parts);
    parts = [];
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    // A reply never spans the fork point or two owners.
    if (index > 0 && ownerOf(rows[index - 1]) !== ownerOf(row)) finish();
    switch (row.kind) {
      // A divider inside a reply (autocompaction mid-task) does not end it.
      case "compaction":
        continue;
      case "handoff-seed":
        finish();
        continue;
      case "turn":
        if (row.turn.role === "assistant") {
          parts.push(row.turn);
          continuing[index] = continuesResponse(rows, index, awaitingSubagents);
          if (!continuing[index]) finish();
        } else if (row.turn.role !== "user" || !parts.length) finish();
    }
  }
  finish();
  return { partsByFinalTurnId: groups, continuing };
}

/**
 * Whether the reply this row ends continues in a later row. Only a finished
 * turn ends a reply: a notification-woken continuation, a server-stamped
 * steer, a running autocompaction, or background subagents still running keep
 * it open. Inherited rows never continue into the fork's own rows.
 */
export function continuesResponse(
  rows: readonly TranscriptRow[],
  index: number,
  awaitingSubagents: boolean,
) {
  const row = rows[index];
  if (row?.kind !== "turn" || row.turn.role !== "assistant" || row.turn.status !== "complete")
    return false;
  // Look past dividers: a compaction between two parts of one reply is part of the work.
  let nextIndex = index + 1;
  let autocompacting = false;
  for (let next = rows[nextIndex]; next?.kind === "compaction"; next = rows[++nextIndex]) {
    // A running autocompaction is the same run: the reply resumes after it.
    if (
      !isTerminalTurnStatus(next.turn.status) &&
      readCompactionFacts(next.turn).trigger === "auto"
    )
      autocompacting = true;
  }
  const next = rows[nextIndex];
  // The fork's subagents are its own: they never wake an inherited reply.
  if (!next) return row.inherited ? false : autocompacting || awaitingSubagents;
  if (ownerOf(next) !== ownerOf(row) || next.kind !== "turn") return false;
  if (next.turn.role === "assistant") return true;
  const metadata = next.turn.metadata;
  return (
    next.turn.role === "user" &&
    Boolean(
      metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        metadata.delivery === "steer",
    )
  );
}
