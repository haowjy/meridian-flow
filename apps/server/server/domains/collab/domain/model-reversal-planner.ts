/** Captured destination, stack, and eligibility facts shared by model reversal commands and history. */

import { undoInRooms } from "@meridian/agent-edit/integration";
import { type DocumentRoom, loroRoomName } from "@meridian/contracts/protocol";
import { freshServerPeerId, holdsEdit, type RoomDocs } from "@meridian/document-model";
import { partKey as key } from "./inverse-actions.js";
import { type Entry, entries, inspectionActions } from "./model-inverse-selection.js";
import type {
  InverseDocument,
  StoredInversePart,
  TurnInverseQuery,
} from "./turn-inverse-service.js";

export type ModelInverseQuery = TurnInverseQuery & { model: true };

/** A part an Undo can take: an AI write, which carries its Undo-rule edit. */
export type UndoablePart = StoredInversePart & { edit: NonNullable<StoredInversePart["edit"]> };
export const undoable = (part: StoredInversePart): part is UndoablePart => part.edit !== null;

/**
 * One immutable capture's reversal policy. A retry creates a new planner from a new capture. The
 * caller frees it: it takes planned steps back on private copies of the captured rooms.
 */
export function createCapturedReversalPlanner(document: InverseDocument, query: TurnInverseQuery) {
  const own = entries(document.history, query.threadId);
  const actions = inspectionActions(document.history, own);
  const poppableByTurn = new Map<string, Set<string>>();
  type TextFailure = "draft_archived" | "document_deleted";
  type TextOmission = {
    ordinal: number;
    cause: "already_removed" | "compacted" | "draft_archived";
  };
  /** A part an Undo took (the writer's card, the writer's revert, or the model's own undo). */
  const takenBy = (part: StoredInversePart) => actions.actions.byPart.get(key(part));
  const taken = (part: StoredInversePart) => takenBy(part) !== undefined;
  const capturedRoom = (room: DocumentRoom) => {
    const captured = document.rooms.get(loroRoomName(room));
    if (!captured) throw new Error("A part's room is not among the capture's rooms");
    return captured;
  };
  const captured = (part: StoredInversePart) => capturedRoom(part.room);
  /** Whether the part's room is held by a closed owner (an archived draft or Work). */
  const closed = (part: StoredInversePart) => captured(part).closed !== null;
  /**
   * Each room after the steps planned so far, so a later step of one command is judged on what
   * the earlier ones leave, as its commit will: the capture until a step writes there, then a copy.
   */
  const planned = new Map<string, RoomDocs>();
  const docsNow = (part: StoredInversePart) =>
    planned.get(loroRoomName(part.room)) ?? captured(part).docs;
  /**
   * Why a part can't go back now, or null when it goes back (design §2, "An Undo always runs"): an
   * Undo took it already, or its room cut the history it needs.
   */
  const unavailable = (part: StoredInversePart) =>
    taken(part)
      ? ("already_removed" as const)
      : !part.edit || !holdsEdit(docsNow(part), part.edit)
        ? ("compacted" as const)
        : null;
  /** Takes `parts` back on the planned copies, each in its room; returns those that went, and those whose history was cut. */
  const planTakeOut = (parts: readonly StoredInversePart[]) => {
    const held = parts.filter(undoable);
    const { compacted } = undoInRooms(held, (room) => {
      const name = loroRoomName(room);
      let copy = planned.get(name);
      if (!copy) {
        copy = capturedRoom(room).docs.fork(freshServerPeerId());
        planned.set(name, copy);
      }
      return copy;
    });
    return { taken: held.filter((part) => !compacted.has(part)), compacted: compacted.size };
  };

  function textSelection(entry: Entry) {
    const selection: StoredInversePart[] = [];
    const partial: TextOmission[] = [];
    for (const original of [...entry.parts].sort((a, b) => b.id - a.id)) {
      if (closed(original)) return { selection, partial, refusal: "draft_archived" as const };
      const cause = unavailable(original);
      if (!cause) selection.push(original);
      else partial.push({ ordinal: original.ordinal, cause });
    }
    return { selection, partial, refusal: null };
  }
  function textPlan(entry: Entry, direction: "undo" | "revert") {
    if (document.removal) return { failure: "document_deleted" as const };
    const selected = direction === "revert" ? revertSelection(entry) : textSelection(entry);
    if ("refusal" in selected && selected.refusal)
      return { failure: selected.refusal as TextFailure };
    return {
      actionKind: direction,
      selection: selected.selection,
      omissions: "partial" in selected ? selected.partial : selected.skipped,
    };
  }
  function turnTextPlan(entry: Entry, turn: TurnInverseQuery) {
    // A deleted document, or a part a closed owner holds, has nothing the card's Undo can take.
    if (document.removal) return null;
    const actionKind = poppableForTurn(turn).has(entry.id)
      ? ("undo" as const)
      : ("revert" as const);
    return { actionKind, selection: entry.parts.filter((part) => !closed(part)) };
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
      const reason = closed(part) ? ("draft_archived" as const) : unavailable(part);
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
    unavailable,
    free: () => {
      for (const copy of planned.values()) copy.free();
    },
  };
}
