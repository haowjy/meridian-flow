/** Captured destination, stack, and eligibility facts shared by model reversal commands and history. */

import {
  editStays,
  freshServerPeerId,
  holdsEdit,
  loadEdit,
  type RoomDocs,
  undoEdits,
} from "@meridian/document-model";
import { partKey as key } from "./inverse-actions.js";
import { type Entry, entries, inspectionActions } from "./model-inverse-selection.js";
import type {
  InverseDocument,
  StoredInversePart,
  TurnInverseQuery,
} from "./turn-inverse-service.js";

export type ModelInverseQuery = TurnInverseQuery & { model: true };

/**
 * Whether `part`'s write would go back on `docs` now, by design §2's Undo rule: nobody has written
 * over it since (`editStays`), and the room still holds its history.
 */
export function standsIn(docs: RoomDocs, part: StoredInversePart): boolean {
  const { edit } = part;
  return !!edit && holdsEdit(docs, edit) && editStays(docs, loadEdit(docs, edit)) === null;
}

/**
 * `parts`, newest first, taken back on `docs` by the Undo rule, each judged on what the ones before
 * it left. Returns the changes, committed, and the parts that went.
 */
export function takeOut(docs: RoomDocs, parts: readonly StoredInversePart[], message?: string) {
  const held = parts.filter((part) => part.edit);
  const { changes, stayed } = undoEdits(
    docs,
    held.map((part) => part.edit as NonNullable<StoredInversePart["edit"]>),
    message,
  );
  return { changes, taken: held.filter((_, i) => !stayed.has(i)) };
}

/**
 * One immutable capture's reversal policy. A retry creates a new planner from a new capture. The
 * caller frees it: it takes planned steps back on a private copy of the captured room.
 */
export function createCapturedReversalPlanner(document: InverseDocument, query: TurnInverseQuery) {
  const { destination } = document;
  const own = entries(document.history, query.threadId);
  const actions = inspectionActions(document.history, own);
  const poppableByTurn = new Map<string, Set<string>>();
  type TextFailure = "draft_archived" | "document_deleted" | "changed";
  type TextOmission = {
    ordinal: number;
    cause: "already_removed" | "edited_since" | "draft_archived";
  };
  /** A part an Undo took (the writer's card, the writer's revert, or the model's own undo). */
  const takenBy = (part: StoredInversePart) => actions.actions.byPart.get(key(part));
  const taken = (part: StoredInversePart) => takenBy(part) !== undefined;
  /**
   * The room after the steps planned so far, so a later step of one command is judged on what
   * the earlier ones leave, as its commit will: the capture until the first step, then a copy.
   */
  let planned: RoomDocs | null = null;
  const docsNow = () => planned ?? document.docs;
  /** Whether the part's write would still go back. */
  const stands = (part: StoredInversePart) => standsIn(docsNow(), part);
  /** Takes `parts` back on the planned copy; returns those that went. */
  const planTakeOut = (parts: readonly StoredInversePart[]) => {
    planned ??= document.docs.fork(freshServerPeerId());
    return takeOut(planned, parts).taken;
  };
  /** A part whose write someone has written over since. */
  const changed = (part: StoredInversePart) => !stands(part);
  /** Why a part is not available: an Undo took it, or someone wrote over it. */
  const unavailableCause = (part: StoredInversePart) =>
    taken(part) ? ("already_removed" as const) : ("edited_since" as const);
  function refusal(part: StoredInversePart): TextFailure | null {
    if (destination.closed) return "draft_archived";
    return stands(part) ? null : "changed";
  }

  function textSelection(entry: Entry) {
    const selection: StoredInversePart[] = [];
    const partial: TextOmission[] = [];
    for (const original of [...entry.parts].sort((a, b) => b.id - a.id)) {
      const refused = refusal(original);
      if (!refused) selection.push(original);
      else if (refused === "changed")
        partial.push({ ordinal: original.ordinal, cause: unavailableCause(original) });
      else return { selection, partial, refusal: refused };
    }
    return { selection, partial, refusal: null };
  }
  function textPlan(entry: Entry, direction: "undo" | "revert") {
    if (destination.closed) return { failure: "draft_archived" as const };
    if (destination.removed) return { failure: "document_deleted" as const };
    const selected = direction === "revert" ? revertSelection(entry) : textSelection(entry);
    if ("refusal" in selected && selected.refusal) return { failure: selected.refusal };
    return {
      destination,
      actionKind: direction,
      selection: selected.selection,
      omissions: "partial" in selected ? selected.partial : selected.skipped,
    };
  }
  function turnTextPlan(entry: Entry, turn: TurnInverseQuery) {
    // A closed owner or a deleted document has nothing the card's Undo can take.
    if (destination.closed || destination.removed) return null;
    const actionKind = poppableForTurn(turn).has(entry.id)
      ? ("undo" as const)
      : ("revert" as const);
    return { destination, actionKind, selection: entry.parts };
  }
  function poppableForTurn(turn: TurnInverseQuery) {
    const turnKey = `${turn.threadId}:${turn.turnId ?? ""}`;
    const cached = poppableByTurn.get(turnKey);
    if (cached) return cached;
    const poppable = new Set<string>();
    for (const entry of actions.stack) {
      const belongsToTurn = entry.parts.some(
        (part) => part.threadId === turn.threadId && part.turnId === turn.turnId,
      );
      if (!belongsToTurn) break;
      poppable.add(entry.id);
    }
    poppableByTurn.set(turnKey, poppable);
    return poppable;
  }
  function revertSelection(entry: Entry) {
    const skipped: TextOmission[] = [];
    const selection: StoredInversePart[] = [];
    for (const part of entry.parts) {
      const reason = destination.closed
        ? "draft_archived"
        : stands(part)
          ? null
          : unavailableCause(part);
      if (reason) skipped.push({ ordinal: part.ordinal, cause: reason });
      else selection.push(part);
    }
    return { selection, skipped };
  }
  return {
    own,
    actions,
    textPlan,
    turnTextPlan,
    takenBy,
    planTakeOut,
    changed,
    free: () => planned?.free(),
  };
}
