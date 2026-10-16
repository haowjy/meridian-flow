/**
 * view-transcript — the one pure function that decides which rows a chat shows and what each
 * reply's items are. The app draws its output and `./mf thread view` prints it, so a chat
 * change can be checked in the terminal. Inputs are plain data; strings and formatting stay
 * with the caller.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { retryTargetOf } from "@meridian/contracts/threads";
import { type AssistantView, viewAssistantTurn } from "./assistant-view";
import { groupDeliveryEvents } from "./delivery-groups";
import { normalizeTurns, type TurnFacts } from "./normalize-turns";
import { isOptimisticTurnId } from "./optimistic-turn-id";
import { replyDrawsNothing } from "./reply-draws-nothing";
import {
  buildTranscriptModel,
  type DeliveryEvent,
  type InheritedTranscript,
  type PersistedContractFailure,
  type TranscriptRow,
} from "./transcript-model";
import { type TurnStats, turnStats } from "./turn-stats";
import { projectWriterText, type WriterText } from "./writer";

export type TranscriptViewInput = TurnFacts & {
  /** A fork's frozen prefix from its source, or omitted when none is known. */
  inherited?: InheritedTranscript | null;
  activity: {
    /** Background subagents are still running; their notification will wake the latest reply. */
    awaitingSubagents: boolean;
  };
  /** Ids of accepted writer turns the model hasn't read yet. */
  queued?: ReadonlySet<string>;
  /**
   * Turns a card is anchored on (`chatCards().anchoredTurnIds`): their row stays even when they are
   * forgotten, retried or past, because the card needs somewhere to be. `./mf` passes the same set.
   */
  anchoredTurnIds?: ReadonlySet<string>;
  /**
   * A queued switch applies when the next run starts (`awaiting_run` in the record). Its notice
   * then sits before that run's reply stand-in (`controlSlot`), where its turn will land.
   */
  switchAwaitsRun?: boolean;
  /** Called for a persisted record that misses its contract. The caller decides where it is reported. */
  onContractFailure?: (failure: PersistedContractFailure) => void;
};

/** What comparisons use: the server's turn id, the row kind and the occurrence within the turn. */
export type RowIdentity = {
  /** Null for a row the server hasn't stated: a local writer turn, the opening seed, or a stand-in with no stored turn behind it. */
  turnId: string | null;
  kind: TranscriptRow["kind"];
  occurrence: number;
};

export type ViewRow = TranscriptRow & {
  identity: RowIdentity;
  /** The React key. It is not identity: nothing compares render keys. */
  renderKey: string;
  /**
   * Subagent notifications and other deliveries that belong to this reply, in order, grouped as
   * drawn: contiguous completions are one group (one merged row), anything else stands alone.
   */
  deliveries: readonly (readonly DeliveryEvent[])[];
  /** A closing turn follows this one (drawn or not): the chat moved on, so a failure here has ended and has no Retry. */
  movedPast: boolean;
  /** The reply continues in a later row, so this one has no settled action row. */
  continuing: boolean;
  /**
   * On every reply-shaped row (a reply, a custom-block system card): the parts that make its
   * response and their usage numbers. A row outside a response group is its own single part.
   * Null on writer messages and special rows.
   */
  response: { parts: readonly Turn[]; stats: TurnStats } | null;
  /** An accepted writer turn the model hasn't read yet. */
  queued: boolean;
};

export type TranscriptView = {
  /** The stored turns with stand-ins placed: every turn the view was computed over, in order. */
  turns: Turn[];
  rows: ViewRow[];
  /** Writer rows' text with reference and skill occurrences, by turn id. */
  writer: ReadonlyMap<string, WriterText>;
  /** Items of every turn row that is not a writer message (replies, custom-block system cards), by turn id. */
  items: ReadonlyMap<string, AssistantView>;
  /**
   * The index in `rows` before which a queued switch's notice sits: the first reply stand-in
   * the server doesn't have yet when `switchAwaitsRun`, else `rows.length` (the tail). A switch
   * a reply holds the chat for applies after that reply, so it stays at the tail.
   */
  controlSlot: number;
  /** Where a child's latest line is shown: child thread id to the reply's turn id. */
  revealTurnByChildThreadId: ReadonlyMap<string, string>;
};

function groupsOf(events: readonly DeliveryEvent[] | undefined) {
  return events ? groupDeliveryEvents(events) : NO_DELIVERIES;
}

function responseOf(parts: readonly Turn[]): NonNullable<ViewRow["response"]> {
  return { parts, stats: turnStats(parts) };
}

const NO_DELIVERIES: readonly (readonly DeliveryEvent[])[] = [];

export function viewTranscript(input: TranscriptViewInput): TranscriptView {
  const standIns = input.standIns ?? [];
  const normalized = normalizeTurns(input);
  const { placed } = normalized;
  // A card needs its turn's row, so an anchored turn outranks Retry suppression and forgetting
  // (a refused Retry's reply is stamped by the competing Retry that won). Inherited rows are never
  // filtered by stamp: page membership is authoritative, and the server already applied the stamps
  // inside the fork's span.
  const anchored = input.anchoredTurnIds;
  const effective = new Set(normalized.turns.map((turn) => turn.id));
  const turns = placed.filter(
    (turn) => !input.hidden?.has(turn.id) && (anchored?.has(turn.id) || effective.has(turn.id)),
  );
  // Provenance is stated, never read from an id's shape: only the server's own turns are named.
  const stored = new Set(input.turns.map((turn) => turn.id));
  const unconfirmed = new Set(standIns.map((turn) => turn.id).filter((id) => !stored.has(id)));
  if (input.opening) unconfirmed.add(input.opening.id);
  const model = buildTranscriptModel(
    turns,
    input.activity.awaitingSubagents,
    input.inherited ?? null,
    input.onContractFailure,
  );
  // A failure shows only while the writer can act on it: until the chat moves past the reply (a closing
  // turn follows it, drawn or not; a write-mode line does not close it). A failed reply the chat moved past
  // has no failure line, and with nothing to read it has no row, unless a card is anchored on it.
  const leavesNoTrace = (row: TranscriptRow) =>
    (row.kind === "compaction" || (row.kind === "turn" && row.turn.role === "assistant")) &&
    row.turn.status === "error" &&
    model.movedPast(row.turn) &&
    !anchored?.has(row.turn.id) &&
    replyDrawsNothing(
      row.turn,
      (model.deliveryEventsByAssistantTurnId.get(row.turn.id) ?? []).map((event) => event.turn),
    );
  const occurrences = new Map<string, number>();
  const writer = new Map<string, WriterText>();
  const items = new Map<string, AssistantView>();
  const rows = model.rows.flatMap((row, index): ViewRow[] => {
    const { turn } = row;
    if (leavesNoTrace(row)) return [];
    const slot = `${turn.id}\0${row.kind}`;
    const occurrence = occurrences.get(slot) ?? 0;
    occurrences.set(slot, occurrence + 1);
    const parts = model.partsByFinalTurnId.get(turn.id);
    if (row.kind === "turn") {
      // Every bubble that is not the writer's own (a reply, a custom-block system card) is drawn as items.
      if (turn.role === "user") writer.set(turn.id, projectWriterText(turn));
      else items.set(turn.id, viewAssistantTurn(turn));
    }
    return [
      {
        ...row,
        identity: {
          turnId: isOptimisticTurnId(turn.id) || unconfirmed.has(turn.id) ? null : turn.id,
          kind: row.kind,
          occurrence,
        },
        renderKey: turn.id,
        deliveries: groupsOf(model.deliveryEventsByAssistantTurnId.get(turn.id)),
        continuing: model.continuing[index] ?? false,
        movedPast: model.movedPast(turn),
        response: row.kind === "turn" && turn.role !== "user" ? responseOf(parts ?? [turn]) : null,
        queued: row.kind === "turn" && !row.inherited && (input.queued?.has(turn.id) ?? false),
      },
    ];
  });
  // The chat's next run is the Retry whose failed reply is still the last reply: a stand-in
  // that newer replies have overtaken (a lost Retry from earlier history) never qualifies, so
  // a switch's notice cannot jump up into old history. With none, the slot is the tail.
  const overtaken = (standIn: Turn) => {
    const target = retryTargetOf(standIn);
    const at = placed.findIndex((turn) => turn.id === target);
    return (
      at >= 0 &&
      placed.some(
        (turn, index) => index > at && turn.role === "assistant" && turn.id !== standIn.id,
      )
    );
  };
  const standInReplies = new Set(
    standIns
      .filter((turn) => turn.role === "assistant" && !stored.has(turn.id) && !overtaken(turn))
      .map((turn) => turn.id),
  );
  const standInAt = input.switchAwaitsRun
    ? rows.findIndex((row) => row.kind === "turn" && standInReplies.has(row.turn.id))
    : -1;
  return {
    turns,
    rows,
    controlSlot: standInAt < 0 ? rows.length : standInAt,
    writer,
    items,
    revealTurnByChildThreadId: model.latestRevealTurnByChildThreadId,
  };
}
