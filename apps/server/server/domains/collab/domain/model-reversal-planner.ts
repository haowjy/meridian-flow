/** Captured destination, stack, and eligibility facts shared by model reversal commands and history. */

import type { Node as PMNode } from "prosemirror-model";
import { partKey as key } from "./inverse-actions.js";
import { takeBack } from "./inverse-text.js";
import { type Entry, entries, inspectionActions } from "./model-inverse-selection.js";
import type {
  InverseDocument,
  StoredInversePart,
  TurnInverseQuery,
} from "./turn-inverse-service.js";

export type ModelInverseQuery = TurnInverseQuery & { model: true };

/** One immutable capture's reversal policy. A retry creates a new planner from a new capture. */
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
   * Live's text after the steps planned so far, so a later step of one command is judged on what
   * the earlier ones leave, as its commit will.
   */
  let text: readonly PMNode[] = document.live;
  const textNow = () => text;
  /** Whether a change of the part still stands in Live. */
  const stands = (part: StoredInversePart) => takeBack(textNow(), [part]).taken.length > 0;
  /** Records that `parts` were chosen to be taken out of Live. */
  const planTakeOut = (parts: readonly StoredInversePart[]) => {
    text = takeBack(textNow(), parts).live;
  };
  /** A part whose text no longer reads as the edit wrote it. */
  const changed = (part: StoredInversePart) => !stands(part);
  /** Why a part is not available: the text no longer holds it. */
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
  return { own, actions, textPlan, turnTextPlan, takenBy, planTakeOut, changed };
}
