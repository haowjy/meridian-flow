/** Transcript rows, response boundaries, delivery events and reveal targets: the indexed reading `viewTranscript` assembles. */
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/protocol";
import {
  isHandoffSeed,
  isOverflowShell,
  readCompactionFacts,
  readThreadReferences,
  readWriteModeSwitch,
  type ThreadReference,
} from "@meridian/contracts/threads";
import { sameJson } from "../turns/same-turn";
import { latestRow } from "./latest-row";
import {
  type CompletionFact,
  type PersistedContractFailure,
  turnSubagentFacts,
} from "./subagent-facts";

export type { PersistedContractFailure } from "./subagent-facts";

export type TurnClass = "bubble" | "delivery" | "context" | "write-mode" | "plumbing";
const emptyEvents: DeliveryEvent[] = [];
export type DeliveryEvent = {
  turn: Turn;
  /** The notification's text as drawn; empty when it only carries an attachment. */
  message: string;
  childThreadId?: string;
  agentName?: string;
  title?: string;
  subagentUpdate: CompletionFact["update"] | null;
};

const deliveryEventCache = new WeakMap<Turn, DeliveryEvent>();

function internDeliveryEvent(event: DeliveryEvent): DeliveryEvent {
  const previous = deliveryEventCache.get(event.turn);
  const fields = {
    turn: "reference",
    message: "value",
    childThreadId: "value",
    agentName: "value",
    title: "value",
    subagentUpdate: "json",
  } satisfies Record<keyof DeliveryEvent, "reference" | "value" | "json">;
  const equal =
    previous &&
    (Object.keys(fields) as (keyof DeliveryEvent)[]).every((field) =>
      fields[field] === "json"
        ? sameJson(previous[field], event[field])
        : previous[field] === event[field],
    );
  if (equal) return previous;
  deliveryEventCache.set(event.turn, event);
  return event;
}

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
  | { kind: "compaction"; turn: Turn; inherited: InheritedMark | null }
  /** A write-mode switch: the line where the chat's mode changed. It ends a reply. */
  | { kind: "write-mode"; turn: Turn; inherited: InheritedMark | null }
  /** A handoff seed S: the brief card. Only the newest local seed can be retried, and only while no closing row follows it. */
  | { kind: "handoff-seed"; turn: Turn; latest: boolean; inherited: InheritedMark | null }
  /**
   * The `from` sources a spawned child's seed message names. The seed itself
   * is a delivery, never a bubble, so its references get a row of their own.
   */
  | {
      kind: "thread-reference";
      turn: Turn;
      references: readonly ThreadReference[];
      inherited: InheritedMark | null;
    };

export function classifyTurn(turn: Turn): TurnClass {
  const metadata =
    turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
      ? turn.metadata
      : null;
  if (turn.role === "compaction") return "plumbing";
  if (turn.role === "assistant") return "bubble";
  if (turn.role === "system" && readWriteModeSwitch(turn)) return "write-mode";
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

/**
 * What the view draws for a turn, or null when the turn has no row of its own. This is the one rule for
 * "which turns are rows": the builder draws from it and the delivery walk stops at it, so the view and the
 * server's forgetting decision group deliveries the same way. It reads `turn.blocks` (an overflow shell is
 * empty, a child seed carries thread references) and the turn that follows, so a caller must hand it a turn
 * with its blocks loaded. It is visual membership only: whether a turn closes the chat is `isClosingRow`.
 */
export type RowShape =
  | { kind: "compaction" | "write-mode" | "turn" | "handoff-seed" }
  | { kind: "thread-reference"; references: readonly ThreadReference[] };

export function rowOf(turn: Turn, successor: Turn | undefined): RowShape | null {
  if (turn.role === "compaction") return { kind: "compaction" };
  // A fork of a handoff inherits its brief, read-only.
  if (isHandoffSeed(turn)) return { kind: "handoff-seed" };
  if (isOverflowShell(turn, successor)) return null;
  const kind = classifyTurn(turn);
  if (kind === "write-mode") return { kind: "write-mode" };
  if (kind === "bubble") return { kind: "turn" };
  const references = readThreadReferences(turn.blocks ?? []);
  return references.length ? { kind: "thread-reference", references } : null;
}

/**
 * The delivery turns (a `subagent_update`) the view groups under an assistant reply: those that follow it
 * until the next row (`rowOf`). The caller supplies the successor index and the turns' blocks.
 */
export function deliveriesUnder(
  reply: Turn,
  nextByPrev: ReadonlyMap<string, Turn>,
  onVisit: (visited: Turn) => void = () => {},
): Turn[] {
  const delivered: Turn[] = [];
  const seen = new Set<string>();
  let next = nextByPrev.get(reply.id);
  while (next && !seen.has(next.id)) {
    seen.add(next.id);
    onVisit(next);
    if (rowOf(next, nextByPrev.get(next.id))) break;
    if (classifyTurn(next) === "delivery" && next.role === "system") delivered.push(next);
    next = nextByPrev.get(next.id);
  }
  return delivered;
}

/**
 * Whether a closing turn (`isClosingRow`) follows a turn in this sequence: the chat has moved past it. A
 * failure and its Retry end there. It reads turns, not drawn rows, because an agent's `inbox_message`
 * closes the chat on the server yet draws no row.
 */
export function chatMovedPast(turns: readonly Turn[]): (turn: Turn) => boolean {
  const at = new Map(turns.map((turn, index) => [turn.id, index]));
  const lastClosing = latestRow(turns)?.index ?? -1;
  return (turn) => (at.get(turn.id) ?? Number.POSITIVE_INFINITY) < lastClosing;
}

export function buildTranscriptModel(
  localTurns: Turn[],
  awaitingSubagents: boolean,
  inherited: InheritedTranscript | null = null,
  onContractFailure: (failure: PersistedContractFailure) => void = () => {},
) {
  const turns = inherited?.turns.length ? [...inherited.turns, ...localTurns] : localTurns;
  const nextByPrev = new Map<string, Turn>();
  for (const turn of turns) if (turn.prevTurnId) nextByPrev.set(turn.prevTurnId, turn);
  const rows: TranscriptRow[] = [];
  const movedPast = chatMovedPast(turns);
  let latestSeedIndex = -1;
  turns.forEach((turn, index) => {
    const shape = rowOf(turn, nextByPrev.get(turn.id) ?? turns[index + 1]);
    if (!shape) return;
    const owner = inherited?.ownerByTurnId.get(turn.id) ?? null;
    const mark: InheritedMark | null = owner
      ? { ownerThreadId: owner, startsOwner: false, endsInherited: false }
      : null;
    if (shape.kind === "thread-reference") {
      rows.push({ kind: "thread-reference", turn, references: shape.references, inherited: mark });
    } else if (shape.kind === "handoff-seed") {
      if (!mark) latestSeedIndex = rows.length;
      rows.push({ kind: "handoff-seed", turn, latest: false, inherited: mark });
    } else {
      rows.push({ kind: shape.kind, turn, inherited: mark });
    }
  });
  // A seed is `latest` while it is the newest local seed and the chat has not moved past it: once it has,
  // its failure and Retry end.
  const latestSeed = rows[latestSeedIndex];
  if (latestSeed?.kind === "handoff-seed" && !movedPast(latestSeed.turn))
    rows[latestSeedIndex] = { ...latestSeed, latest: true };
  markInheritedRuns(rows);
  // Index-aligned with `rows`: response grouping and reveal landing read turns.
  const visibleTurns = rows.map((row) => row.turn);
  const subagentUpdateByTurnId = new Map<string, CompletionFact["update"]>();
  const invocationByExecution = new Map<
    string,
    { threadId?: string; agentName: string; title?: string }
  >();
  for (const turn of turns) {
    const facts = turnSubagentFacts(turn);
    if (facts.completion) subagentUpdateByTurnId.set(turn.id, facts.completion.update);
    for (const failure of facts.failures) onContractFailure(failure);
    for (const { card } of facts.invocations)
      if (card.execution)
        invocationByExecution.set(card.execution, {
          ...(card.childThreadId ? { threadId: card.childThreadId } : {}),
          agentName: card.agentName,
          ...(card.title ? { title: card.title } : {}),
        });
  }

  const deliveryEventsByAssistantTurnId = new Map<string, DeliveryEvent[]>();
  const latestRevealTurnByChildThreadId = new Map<string, string>();
  for (const turn of visibleTurns) {
    if (turn.role !== "assistant") continue;
    const events: DeliveryEvent[] = [];
    for (const next of deliveriesUnder(turn, nextByPrev)) {
      const update = subagentUpdateByTurnId.get(next.id) ?? null;
      const invocation = update?.execution
        ? invocationByExecution.get(update.execution)
        : undefined;
      const childThreadId = update?.childThreadId ?? invocation?.threadId;
      events.push(
        internDeliveryEvent({
          turn: next,
          message: next.blocks
            .filter((block) => block.blockType === "text")
            .map((block) => block.textContent ?? "")
            .join(""),
          subagentUpdate: update,
          ...(childThreadId ? { childThreadId } : {}),
          ...(update?.agentName || invocation?.agentName
            ? { agentName: update?.agentName ?? invocation?.agentName }
            : {}),
          ...(invocation?.title ? { title: invocation.title } : {}),
        }),
      );
      if (childThreadId) latestRevealTurnByChildThreadId.set(childThreadId, turn.id);
    }
    if (events.length) deliveryEventsByAssistantTurnId.set(turn.id, events);
  }

  const { partsByFinalTurnId, continuing } = responseGroups(rows, awaitingSubagents);
  return {
    rows,
    visibleTurns,
    movedPast,
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
  let lastPart = -1;
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
      // A switch ends the reply before it, even when the message between the two
      // was stamped a steer: the next reply answers in the new mode.
      case "handoff-seed":
      case "thread-reference":
      case "write-mode":
        // The divider ends continuation too: the reply before it is finished.
        if (lastPart >= 0 && parts.length) continuing[lastPart] = false;
        finish();
        continue;
      case "turn":
        if (row.turn.role === "assistant") {
          parts.push(row.turn);
          lastPart = index;
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
