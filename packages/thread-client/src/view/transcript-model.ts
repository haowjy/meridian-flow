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
  message: string;
  childThreadId?: string;
  agentName?: string;
  title?: string;
  sender?: { threadId: string; ref: string | null; title: string | null };
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
    sender: "json",
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

export type InheritedTranscript = {
  turns: readonly Turn[];
  ownerByTurnId: ReadonlyMap<string, string>;
};

export type InheritedMark = {
  ownerThreadId: string;
  startsOwner: boolean;
  endsInherited: boolean;
};

export type TranscriptRow =
  | { kind: "turn"; turn: Turn; inherited: InheritedMark | null }
  | { kind: "delivery"; turn: Turn; event: DeliveryEvent; inherited: InheritedMark | null }
  | { kind: "compaction"; turn: Turn; inherited: InheritedMark | null }
  | { kind: "write-mode"; turn: Turn; inherited: InheritedMark | null }
  | { kind: "handoff-seed"; turn: Turn; latest: boolean; inherited: InheritedMark | null }
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

function inboxMessageSender(
  turn: Turn,
): { threadId: string; ref: string | null; title: string | null } | null {
  const metadata = turn.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const sender = metadata.sender;
  if (!sender || typeof sender !== "object" || Array.isArray(sender)) return null;
  return typeof sender.threadId === "string" &&
    (typeof sender.ref === "string" || sender.ref === null) &&
    (typeof sender.title === "string" || sender.title === null)
    ? { threadId: sender.threadId, ref: sender.ref, title: sender.title }
    : null;
}

export type RowShape =
  | { kind: "compaction" | "write-mode" | "turn" | "handoff-seed" }
  | { kind: "thread-reference"; references: readonly ThreadReference[] };

export function rowOf(turn: Turn, successor: Turn | undefined): RowShape | null {
  if (turn.role === "compaction") return { kind: "compaction" };
  if (isHandoffSeed(turn)) return { kind: "handoff-seed" };
  if (isOverflowShell(turn, successor)) return null;
  const kind = classifyTurn(turn);
  if (kind === "write-mode") return { kind: "write-mode" };
  if (kind === "bubble") return { kind: "turn" };
  const references = readThreadReferences(turn.blocks ?? []);
  return references.length ? { kind: "thread-reference", references } : null;
}

export type DeliveryPlacement = { kind: "assistant"; assistantTurnId: string } | { kind: "row" };

function isChildSeed(turn: Turn): boolean {
  const metadata = turn.metadata;
  return (
    !!metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    metadata.kind === "inbox_message" &&
    metadata.agentRequestKind === "child_seed"
  );
}

export function placeDeliveries(
  turns: readonly Turn[],
  nextByPrev: ReadonlyMap<string, Turn>,
  onVisit: (visited: Turn) => void = () => {},
): ReadonlyMap<string, DeliveryPlacement> {
  const openAssistantAfter = new Map<string, string | null>();
  const placements = new Map<string, DeliveryPlacement>();
  for (const turn of turns) {
    onVisit(turn);
    const predecessorAssistant = turn.prevTurnId
      ? (openAssistantAfter.get(turn.prevTurnId) ?? null)
      : null;
    const shape = rowOf(turn, nextByPrev.get(turn.id));
    if (classifyTurn(turn) === "delivery" && !isChildSeed(turn)) {
      placements.set(
        turn.id,
        predecessorAssistant
          ? { kind: "assistant", assistantTurnId: predecessorAssistant }
          : { kind: "row" },
      );
    }
    openAssistantAfter.set(
      turn.id,
      shape ? (turn.role === "assistant" ? turn.id : null) : predecessorAssistant,
    );
  }
  return placements;
}

export function deliveriesUnder(
  reply: Turn,
  nextByPrev: ReadonlyMap<string, Turn>,
  onVisit: (visited: Turn) => void = () => {},
): Turn[] {
  const chain = [reply];
  const seen = new Set([reply.id]);
  let next = nextByPrev.get(reply.id);
  while (next && !seen.has(next.id)) {
    seen.add(next.id);
    chain.push(next);
    const successor = nextByPrev.get(next.id);
    if (rowOf(next, successor)) break;
    next = successor;
  }
  const placement = placeDeliveries(chain, nextByPrev, (turn) => {
    if (turn.id !== reply.id) onVisit(turn);
  });
  return chain.filter((turn) => {
    const placed = placement.get(turn.id);
    return placed?.kind === "assistant" && placed.assistantTurnId === reply.id;
  });
}

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
  const subagentUpdateByTurnId = new Map<string, CompletionFact["update"]>();
  const launchTitleByChildThreadId = new Map<string, string>();
  for (const turn of turns) {
    const facts = turnSubagentFacts(turn);
    if (facts.completion) subagentUpdateByTurnId.set(turn.id, facts.completion.update);
    for (const failure of facts.failures) onContractFailure(failure);
    for (const { card } of facts.invocations) {
      if (card.childThreadId && card.title)
        launchTitleByChildThreadId.set(card.childThreadId, card.title);
    }
  }
  const deliveryEventFor = (turn: Turn): DeliveryEvent => {
    const update = subagentUpdateByTurnId.get(turn.id) ?? null;
    const title = update ? launchTitleByChildThreadId.get(update.childThreadId) : undefined;
    const sender = inboxMessageSender(turn);
    return internDeliveryEvent({
      turn,
      message: turn.blocks
        .filter((block) => block.blockType === "text")
        .map((block) => block.textContent ?? "")
        .join(""),
      subagentUpdate: update,
      ...(update ? { childThreadId: update.childThreadId, agentName: update.agentName } : {}),
      ...(title ? { title } : {}),
      ...(sender ? { sender } : {}),
    });
  };
  const deliveryPlacements = placeDeliveries(turns, nextByPrev);
  const deliveriesByAssistant = new Map<string, Turn[]>();
  for (const turn of turns) {
    const placement = deliveryPlacements.get(turn.id);
    if (placement?.kind !== "assistant") continue;
    const grouped = deliveriesByAssistant.get(placement.assistantTurnId) ?? [];
    grouped.push(turn);
    deliveriesByAssistant.set(placement.assistantTurnId, grouped);
  }
  const rows: TranscriptRow[] = [];
  const movedPast = chatMovedPast(turns);
  let latestSeedIndex = -1;
  turns.forEach((turn, index) => {
    const shape = rowOf(turn, nextByPrev.get(turn.id) ?? turns[index + 1]);
    const owner = inherited?.ownerByTurnId.get(turn.id) ?? null;
    const mark: InheritedMark | null = owner
      ? { ownerThreadId: owner, startsOwner: false, endsInherited: false }
      : null;
    if (!shape) {
      if (deliveryPlacements.get(turn.id)?.kind === "row")
        rows.push({ kind: "delivery", turn, event: deliveryEventFor(turn), inherited: mark });
      return;
    }
    if (shape.kind === "thread-reference") {
      rows.push({ kind: "thread-reference", turn, references: shape.references, inherited: mark });
    } else if (shape.kind === "handoff-seed") {
      if (!mark) latestSeedIndex = rows.length;
      rows.push({ kind: "handoff-seed", turn, latest: false, inherited: mark });
    } else {
      rows.push({ kind: shape.kind, turn, inherited: mark });
    }
  });
  const latestSeed = rows[latestSeedIndex];
  if (latestSeed?.kind === "handoff-seed" && !movedPast(latestSeed.turn))
    rows[latestSeedIndex] = { ...latestSeed, latest: true };
  markInheritedRuns(rows);
  const visibleTurns = rows.map((row) => row.turn);

  const deliveryEventsByAssistantTurnId = new Map<string, DeliveryEvent[]>();
  const latestRevealTurnByChildThreadId = new Map<string, string>();
  for (const turn of visibleTurns) {
    if (turn.role !== "assistant") continue;
    const events: DeliveryEvent[] = [];
    for (const next of deliveriesByAssistant.get(turn.id) ?? []) {
      const event = deliveryEventFor(next);
      events.push(event);
      const childThreadId = event.childThreadId;
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
    latestRevealTurnByChildThreadId,
    continuing,
    partsByFinalTurnId,
    deliveryEventsFor: (turnId: string) =>
      deliveryEventsByAssistantTurnId.get(turnId) ?? emptyEvents,
    resolveRevealTurnId: (childThreadId: string, originTurnId: string) =>
      latestRevealTurnByChildThreadId.get(childThreadId) ?? originTurnId,
  };
}

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
    // keep: A reply never spans a fork point or two owners
    if (index > 0 && ownerOf(rows[index - 1]) !== ownerOf(row)) finish();
    switch (row.kind) {
      case "compaction":
        continue;
      case "handoff-seed":
      case "delivery":
      case "thread-reference":
      case "write-mode":
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

export function continuesResponse(
  rows: readonly TranscriptRow[],
  index: number,
  awaitingSubagents: boolean,
) {
  const row = rows[index];
  if (row?.kind !== "turn" || row.turn.role !== "assistant" || row.turn.status !== "complete")
    return false;
  let nextIndex = index + 1;
  let autocompacting = false;
  for (let next = rows[nextIndex]; next?.kind === "compaction"; next = rows[++nextIndex]) {
    if (
      !isTerminalTurnStatus(next.turn.status) &&
      readCompactionFacts(next.turn).trigger === "auto"
    )
      autocompacting = true;
  }
  const next = rows[nextIndex];
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
