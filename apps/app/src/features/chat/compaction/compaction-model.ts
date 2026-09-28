/**
 * Pure reads of compaction dividers and the undo markers that target them.
 *
 * A compaction turn (C) is a transcript row; its undo marker (U, a system
 * turn) never is. U folds into the divider it names: a complete U marks the
 * divider undone, an errored U is a refusal shown on that divider. Metadata is
 * read defensively: the server's codecs own the shape, the client only picks
 * the fields the writer sees.
 */
import type { Turn } from "@meridian/contracts/protocol";
import type { CompactionUndoAvailability } from "@meridian/contracts/threads";
import type { QueuedControl } from "./thread-controls";

export type CompactionTrigger = "auto" | "manual";

export type CompactionFacts = {
  trigger: CompactionTrigger;
  /** The writer control this divider ran (`controlMessageId`) or absorbed (`satisfiesControlId`). */
  controlIds: readonly string[];
  /** Typed failure reason on an errored divider; null otherwise. */
  failureReason: string | null;
  summary: string | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
};

/** What the writer's undo of one divider has done so far. */
export type CompactionUndoMarkers = {
  /** The complete U that restored the history this divider summarized. */
  undone: Turn | null;
  /** The latest refused U, when no U has succeeded. */
  refusal: Turn | null;
};

export const NO_UNDO_MARKERS: CompactionUndoMarkers = { undone: null, refusal: null };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function isCompactionTurn(turn: Turn): boolean {
  return turn.role === "compaction";
}

export function readCompactionFacts(turn: Turn): CompactionFacts {
  const metadata = record(turn.metadata);
  const controlMessageId = text(metadata?.controlMessageId);
  const satisfiesControlId = text(metadata?.satisfiesControlId);
  const trigger: CompactionTrigger =
    metadata?.trigger === "manual" || (metadata?.trigger === undefined && controlMessageId)
      ? "manual"
      : "auto";
  const summaryBlock = (turn.blocks ?? []).find(
    (block) => block.blockType === "custom" && record(block.content)?.kind === "compaction",
  );
  const props = record(record(summaryBlock?.content)?.props);
  return {
    trigger,
    controlIds: [controlMessageId, satisfiesControlId].filter((id): id is string => id !== null),
    failureReason: turn.status === "error" ? text(metadata?.reason) : null,
    summary: text(props?.summary),
    tokensBefore: count(props?.tokensBefore),
    tokensAfter: count(props?.tokensAfter),
  };
}

/** The divider a U names, or null when the turn is not an undo marker. */
export function undoMarkerTarget(turn: Turn): string | null {
  if (turn.role !== "system") return null;
  const metadata = record(turn.metadata);
  return metadata?.kind === "compaction_undo" ? text(metadata.revertsCompactionTurnId) : null;
}

/** The control a U executed, when it names one. */
export function undoMarkerControlId(turn: Turn): string | null {
  return text(record(turn.metadata)?.controlMessageId);
}

/**
 * Every writer control a turn already answers: a divider that ran or absorbed
 * it, or an undo marker. A queued item for one of these is no longer queued.
 */
export function answeredControlIds(turns: readonly Turn[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    if (turn.role === "compaction")
      for (const id of readCompactionFacts(turn).controlIds) ids.add(id);
    else if (undoMarkerTarget(turn)) {
      const id = undoMarkerControlId(turn);
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Folds every U into the divider it targets, in transcript order. */
export function collectUndoMarkers(turns: readonly Turn[]): Map<string, CompactionUndoMarkers> {
  const markers = new Map<string, CompactionUndoMarkers>();
  for (const turn of turns) {
    const target = undoMarkerTarget(turn);
    if (!target) continue;
    const current = markers.get(target) ?? NO_UNDO_MARKERS;
    if (turn.status === "complete") markers.set(target, { undone: turn, refusal: null });
    else if (turn.status === "error" && !current.undone)
      markers.set(target, { ...current, refusal: turn });
  }
  return markers;
}

/**
 * R4: a context-window overflow completes the running assistant turn empty
 * before the compaction that recovers it. It says nothing to the writer.
 */
export function isOverflowShell(turn: Turn, next: Turn | undefined): boolean {
  return (
    next?.role === "compaction" &&
    turn.role === "assistant" &&
    turn.status === "complete" &&
    (turn.blocks ?? []).length === 0
  );
}

export type DividerState = "pending" | "complete" | "failed" | "cancelled" | "undone";

export type DividerUndo =
  /** Undo is offered: the server marks it likely to succeed on this divider. */
  | { kind: "offer" }
  /** An undo control is on its way to the inbox, waiting there, or being withdrawn. */
  | { kind: "queued"; control: QueuedControl }
  | null;

export type DividerView = {
  state: DividerState;
  trigger: CompactionTrigger;
  summary: string | null;
  /** Shown only when the compaction actually made the context smaller. */
  tokens: { before: number; after: number } | null;
  /** Writer copy for a failure the writer must hear about; null keeps R3's quiet divider. */
  failureCopy: string | null;
  undo: DividerUndo;
  /** The writer's last undo request was withdrawn before it ran. */
  undoNote: "withdrawn" | null;
  /** Writer copy from the latest refused undo, while no undo has succeeded. */
  refusalCopy: string | null;
};

const ACTIVE_UNDO: ReadonlySet<QueuedControl["status"]> = new Set([
  "queued",
  "failed",
  "withdrawing",
  "withdraw_failed",
]);

/**
 * One divider's view state. `failureCopyFor` supplies client-owned copy for
 * reasons whose server copy would mislead (`compactionFailureCopy` in
 * `CompactionDivider.tsx`).
 */
export function dividerView(input: {
  turn: Turn;
  markers: CompactionUndoMarkers;
  undoAvailability: CompactionUndoAvailability;
  queuedUndo: QueuedControl | null;
  failureCopyFor: (reason: string | null, serverCopy: string | null) => string | null;
}): DividerView {
  const { turn, markers, undoAvailability, queuedUndo } = input;
  const facts = readCompactionFacts(turn);
  const state: DividerState = markers.undone
    ? "undone"
    : turn.status === "pending" || turn.status === "streaming"
      ? "pending"
      : turn.status === "error"
        ? "failed"
        : turn.status === "cancelled"
          ? "cancelled"
          : "complete";
  const tokens =
    facts.tokensBefore !== null &&
    facts.tokensAfter !== null &&
    facts.tokensAfter < facts.tokensBefore
      ? { before: facts.tokensBefore, after: facts.tokensAfter }
      : null;
  // R3: an autocompaction's failure is carried by the failed reply under the
  // writer's newest message. A manual one has no reply to carry it.
  const failureCopy =
    state === "failed" && facts.trigger === "manual"
      ? input.failureCopyFor(facts.failureReason, turn.error)
      : null;
  const activeUndo = queuedUndo && ACTIVE_UNDO.has(queuedUndo.status) ? queuedUndo : null;
  let undo: DividerUndo = null;
  if (state === "complete") {
    if (activeUndo) undo = { kind: "queued", control: activeUndo };
    // R-C6-2: offer Undo only where it is likely to succeed. `would_recompact`
    // means restoring the history would compact it again at once.
    else if (undoAvailability?.turnId === turn.id && undoAvailability.availability === "likely")
      undo = { kind: "offer" };
  }
  const refusalCopy = state === "complete" && !activeUndo ? (markers.refusal?.error ?? null) : null;
  return {
    state,
    trigger: facts.trigger,
    summary: facts.summary,
    tokens,
    failureCopy,
    undo,
    undoNote: state === "complete" && queuedUndo?.status === "withdrawn" ? "withdrawn" : null,
    refusalCopy,
  };
}
