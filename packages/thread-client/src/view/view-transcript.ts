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
import { isOptimisticTurnId } from "./optimistic-turn-id";
import { replyDrawsNothing } from "./reply-draws-nothing";
import { placeStandIns } from "./retry-stand-ins";
import {
  buildTranscriptModel,
  type DeliveryEvent,
  type InheritedTranscript,
  type PersistedContractFailure,
  type TranscriptRow,
} from "./transcript-model";
import { type TurnStats, turnStats } from "./turn-stats";
import { projectWriterText, type WriterText } from "./writer";

export type TranscriptViewInput = {
  /** Stored turns in order, local writer turns included. */
  turns: Turn[];
  /**
   * The seed card of a handoff whose destination the server hasn't created yet. It leads the
   * transcript, ahead of stand-in placement. Today's stand-in producers never anchor to it:
   * a Retry follows a stored turn or a reply, so placement never has to order a stand-in
   * against this seed.
   */
  opening?: Turn | null;
  /** A fork's frozen prefix from its source, or omitted when none is known. */
  inherited?: InheritedTranscript | null;
  activity: {
    /** Background subagents are still running; their notification will wake the latest reply. */
    awaitingSubagents: boolean;
  };
  /** Local placeholders for turns the server doesn't have yet, laid over `turns` by `prevTurnId`. */
  standIns?: readonly Turn[];
  /** Ids of accepted writer turns the model hasn't read yet. */
  queued?: ReadonlySet<string>;
  /**
   * Writer turns a hand-back request in flight hides (`hiddenWriterTurns`): they leave the
   * transcript with no row, as they will when the server's answer removes them.
   */
  hidden?: ReadonlySet<string>;
  /**
   * Failed replies whose accepted Retry the stored turns do not show yet: the Retry's target,
   * carried explicitly. A Retry the turns do show says so itself (`metadata.retryOf`, on a stored
   * turn or a stand-in).
   */
  retried?: ReadonlySet<string>;
  /**
   * Failed replies whose Retry the server refused: the caller shows that refusal on them, so
   * their row stays even with nothing else to draw. Local to the caller; `./mf` passes none.
   */
  refused?: ReadonlySet<string>;
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
  const placed = placeStandIns(
    input.opening ? [input.opening, ...input.turns] : input.turns,
    standIns,
  );
  // The transcript is not a log: a failed reply the writer retried is not drawn (its Retry
  // is, in its place), and neither is a message handed back. Stand-ins were placed first, with
  // the failed reply as their anchor, so a pending Retry sits exactly where it was. A chain of
  // failed retries draws only the newest. The turns stay in the store; this is drawing only.
  const retried = new Set(input.retried);
  for (const turn of placed) {
    const target = retryTargetOf(turn);
    if (target !== null) retried.add(target);
  }
  // A forgotten local turn has left the conversation: no row. Only a refused Retry's card still needs its
  // reply's row. Inherited rows are never filtered by stamp: page membership is authoritative, and the server
  // already applied the stamps inside the fork's span.
  const turns = placed.filter(
    (turn) =>
      !retried.has(turn.id) &&
      !input.hidden?.has(turn.id) &&
      (turn.forgottenBy == null || input.refused?.has(turn.id)),
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
  // A failure shows only while the writer can act on it: the latest reply (a write-mode line
  // after it does not close it). A failed reply the chat moved past has no failure line, and
  // with nothing to read it has no row, unless a refused Retry shows its card there.
  let latest = model.rows.length - 1;
  while (latest > 0 && model.rows[latest]?.kind === "write-mode") latest -= 1;
  const leavesNoTrace = (row: TranscriptRow, index: number) =>
    (row.kind === "compaction" || (row.kind === "turn" && row.turn.role === "assistant")) &&
    row.turn.status === "error" &&
    index !== latest &&
    !input.refused?.has(row.turn.id) &&
    replyDrawsNothing(
      row.turn,
      (model.deliveryEventsByAssistantTurnId.get(row.turn.id) ?? []).map((event) => event.turn),
    );
  const occurrences = new Map<string, number>();
  const writer = new Map<string, WriterText>();
  const items = new Map<string, AssistantView>();
  const rows = model.rows.flatMap((row, index): ViewRow[] => {
    const { turn } = row;
    if (leavesNoTrace(row, index)) return [];
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
