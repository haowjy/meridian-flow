import type { Turn } from "@meridian/contracts/protocol";
import { retryTargetOf } from "@meridian/contracts/threads";
import { sameJson } from "../turns/same-turn";
import { type AssistantView, viewAssistantTurn } from "./assistant-view";
import { type DeliveryGroup, groupDeliveryEvents } from "./delivery-groups";
import { type NormalizedTurns, normalizeTurns, type TurnFacts } from "./normalize-turns";
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

export type TranscriptViewInput = (
  | (TurnFacts & { normalized?: never })
  | ({ normalized: NormalizedTurns } & { [K in keyof TurnFacts]?: never })
) & {
  inherited?: InheritedTranscript | null;
  activity: {
    awaitingSubagents: boolean;
  };
  queued?: ReadonlySet<string>;
  anchoredTurnIds?: ReadonlySet<string>;
  switchAwaitsRun?: boolean;
  onContractFailure?: (failure: PersistedContractFailure) => void;
};

export type RowIdentity = {
  turnId: string | null;
  kind: TranscriptRow["kind"];
  occurrence: number;
};

export type ViewRow = TranscriptRow & {
  identity: RowIdentity;
  renderKey: string;
  deliveries: readonly DeliveryGroup[];
  movedPast: boolean;
  continuing: boolean;
  response: { parts: readonly Turn[]; stats: TurnStats } | null;
  queued: boolean;
};

export type TranscriptView = {
  turns: Turn[];
  rows: ViewRow[];
  writer: ReadonlyMap<string, WriterText>;
  items: ReadonlyMap<string, AssistantView>;
  controlSlot: number;
  revealTurnByChildThreadId: ReadonlyMap<string, string>;
};

function groupsOf(events: readonly DeliveryEvent[] | undefined) {
  return events ? groupDeliveryEvents(events) : NO_DELIVERIES;
}

function responseOf(parts: readonly Turn[]): NonNullable<ViewRow["response"]> {
  const anchor = parts.at(-1);
  if (!anchor) return { parts, stats: turnStats(parts) };
  const previous = responseCache.get(anchor);
  if (
    previous &&
    previous.parts.length === parts.length &&
    previous.parts.every((turn, index) => turn === parts[index])
  )
    return previous;
  const response = { parts, stats: turnStats(parts) };
  responseCache.set(anchor, response);
  return response;
}

const NO_DELIVERIES: readonly DeliveryGroup[] = [];
const responseCache = new WeakMap<Turn, NonNullable<ViewRow["response"]>>();
const rowCache = new WeakMap<Turn, Map<string, ViewRow>>();
type RowComparison = "value" | "reference" | "json" | "references";
type RowOf<K extends ViewRow["kind"]> = Extract<ViewRow, { kind: K }>;

const commonRowFields = {
  kind: "value",
  turn: "reference",
  inherited: "json",
  identity: "json",
  renderKey: "value",
  deliveries: "references",
  movedPast: "value",
  continuing: "value",
  response: "reference",
  queued: "value",
} as const;
const turnRowFields = commonRowFields satisfies Record<keyof RowOf<"turn">, RowComparison>;
const deliveryRowFields = {
  ...commonRowFields,
  event: "reference",
} satisfies Record<keyof RowOf<"delivery">, RowComparison>;
const compactionRowFields = commonRowFields satisfies Record<
  keyof RowOf<"compaction">,
  RowComparison
>;
const writeModeRowFields = commonRowFields satisfies Record<
  keyof RowOf<"write-mode">,
  RowComparison
>;
const handoffRowFields = {
  ...commonRowFields,
  latest: "value",
} satisfies Record<keyof RowOf<"handoff-seed">, RowComparison>;
const referenceRowFields = {
  ...commonRowFields,
  references: "json",
} satisfies Record<keyof RowOf<"thread-reference">, RowComparison>;

function sameRowFields<T extends ViewRow>(
  left: T,
  right: T,
  fields: Record<keyof T, RowComparison>,
): boolean {
  return (Object.keys(fields) as (keyof T)[]).every((field) => {
    const comparison = fields[field];
    if (comparison === "json") return sameJson(left[field], right[field]);
    if (comparison === "references") {
      const leftGroups = left[field] as readonly DeliveryGroup[];
      const rightGroups = right[field] as readonly DeliveryGroup[];
      return (
        leftGroups.length === rightGroups.length &&
        leftGroups.every((group, index) => group === rightGroups[index])
      );
    }
    return left[field] === right[field];
  });
}

function sameViewRow(left: ViewRow, right: ViewRow): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "turn":
      return right.kind === "turn" && sameRowFields(left, right, turnRowFields);
    case "delivery":
      return right.kind === "delivery" && sameRowFields(left, right, deliveryRowFields);
    case "compaction":
      return right.kind === "compaction" && sameRowFields(left, right, compactionRowFields);
    case "write-mode":
      return right.kind === "write-mode" && sameRowFields(left, right, writeModeRowFields);
    case "handoff-seed":
      return right.kind === "handoff-seed" && sameRowFields(left, right, handoffRowFields);
    case "thread-reference":
      return right.kind === "thread-reference" && sameRowFields(left, right, referenceRowFields);
  }
}

function internRow(row: ViewRow): ViewRow {
  let variants = rowCache.get(row.turn);
  if (!variants) {
    variants = new Map();
    rowCache.set(row.turn, variants);
  }
  const key = `${row.kind}\0${row.identity.occurrence}`;
  const previous = variants.get(key);
  if (previous && sameViewRow(previous, row)) return previous;
  variants.set(key, row);
  return row;
}

export function viewTranscript(input: TranscriptViewInput): TranscriptView {
  const normalized = input.normalized ?? normalizeTurns(input);
  const facts = normalized.facts;
  const standIns = facts.standIns ?? [];
  const { placed } = normalized;
  const anchored = input.anchoredTurnIds;
  const effective = new Set(normalized.turns.map((turn) => turn.id));
  const turns = placed.filter(
    (turn) => !facts.hidden?.has(turn.id) && (anchored?.has(turn.id) || effective.has(turn.id)),
  );
  const stored = new Set(facts.turns.map((turn) => turn.id));
  const unconfirmed = new Set(standIns.map((turn) => turn.id).filter((id) => !stored.has(id)));
  if (facts.opening) unconfirmed.add(facts.opening.id);
  const model = buildTranscriptModel(
    turns,
    input.activity.awaitingSubagents,
    input.inherited ?? null,
    input.onContractFailure,
  );
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
      if (turn.role === "user") writer.set(turn.id, projectWriterText(turn));
      else items.set(turn.id, viewAssistantTurn(turn));
    }
    return [
      internRow({
        ...row,
        identity: {
          turnId: isOptimisticTurnId(turn.id) || unconfirmed.has(turn.id) ? null : turn.id,
          kind: row.kind,
          occurrence,
        },
        renderKey: turn.id,
        deliveries:
          row.kind === "delivery"
            ? groupsOf([row.event])
            : groupsOf(model.deliveryEventsByAssistantTurnId.get(turn.id)),
        continuing: model.continuing[index] ?? false,
        movedPast: model.movedPast(turn),
        response: row.kind === "turn" && turn.role !== "user" ? responseOf(parts ?? [turn]) : null,
        queued: row.kind === "turn" && !row.inherited && (input.queued?.has(turn.id) ?? false),
      }),
    ];
  });
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
