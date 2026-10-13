/**
 * view-transcript — the one pure function that decides which rows a chat shows and what each
 * reply's items are. The app draws its output and `./mf thread view` prints it, so a chat
 * change can be checked in the terminal. Inputs are plain data; strings and formatting stay
 * with the caller.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { type AssistantView, viewAssistantTurn } from "./assistant-view";
import { isOptimisticTurnId } from "./optimistic-turn-id";
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
  /** Called for a persisted record that misses its contract. The caller decides where it is reported. */
  onContractFailure?: (failure: PersistedContractFailure) => void;
};

/** What comparisons use: the server's turn id, the row kind and the occurrence within the turn. */
export type RowIdentity = {
  /** Null for a local writer turn the server hasn't named. */
  turnId: string | null;
  kind: TranscriptRow["kind"];
  occurrence: number;
};

export type ViewRow = TranscriptRow & {
  identity: RowIdentity;
  /** The React key. It is not identity: nothing compares render keys. */
  renderKey: string;
  /** Subagent notifications and other deliveries that belong to this reply. */
  deliveryEvents: readonly DeliveryEvent[];
  /** The reply continues in a later row, so this one has no settled action row. */
  continuing: boolean;
  /** Present on the last part of a reply: the parts that make it and their usage numbers. */
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
  /** Where a child's latest line is shown: child thread id to the reply's turn id. */
  revealTurnByChildThreadId: ReadonlyMap<string, string>;
};

const NO_EVENTS: readonly DeliveryEvent[] = [];

export function viewTranscript(input: TranscriptViewInput): TranscriptView {
  const turns = placeStandIns(input.turns, input.standIns ?? []);
  const model = buildTranscriptModel(
    turns,
    input.activity.awaitingSubagents,
    input.inherited ?? null,
    input.onContractFailure,
  );
  const occurrences = new Map<string, number>();
  const writer = new Map<string, WriterText>();
  const items = new Map<string, AssistantView>();
  const rows = model.rows.map((row, index): ViewRow => {
    const { turn } = row;
    const slot = `${turn.id}\0${row.kind}`;
    const occurrence = occurrences.get(slot) ?? 0;
    occurrences.set(slot, occurrence + 1);
    const parts = model.partsByFinalTurnId.get(turn.id);
    if (row.kind === "turn") {
      // Every bubble that is not the writer's own (a reply, a custom-block system card) is drawn as items.
      if (turn.role === "user") writer.set(turn.id, projectWriterText(turn));
      else items.set(turn.id, viewAssistantTurn(turn));
    }
    return {
      ...row,
      identity: {
        turnId: isOptimisticTurnId(turn.id) ? null : turn.id,
        kind: row.kind,
        occurrence,
      },
      renderKey: turn.id,
      deliveryEvents: model.deliveryEventsByAssistantTurnId.get(turn.id) ?? NO_EVENTS,
      continuing: model.continuing[index] ?? false,
      response: parts ? { parts, stats: turnStats(parts) } : null,
      queued: row.kind === "turn" && !row.inherited && (input.queued?.has(turn.id) ?? false),
    };
  });
  return {
    turns,
    rows,
    writer,
    items,
    revealTurnByChildThreadId: model.latestRevealTurnByChildThreadId,
  };
}
