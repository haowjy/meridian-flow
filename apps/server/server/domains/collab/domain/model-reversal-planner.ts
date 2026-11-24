/** One document's reversal selection, shared by the model's undo and revert, its edit list and the card. */

import type { StoredDelta } from "@meridian/agent-edit/content-merge";
import { captureDelta } from "@meridian/agent-edit/content-merge";
import { undoInRooms } from "@meridian/agent-edit/integration";
import { type DocumentRoom, loroRoomName } from "@meridian/contracts/protocol";
import {
  changedBlocks,
  editSince,
  encodeChanges,
  holdsEdit,
  type RoomDocs,
  readDocument,
  type StoredEdit,
} from "@meridian/document-model";
import { nodeOf } from "@meridian/loro-prosemirror";
import { inverseSchema } from "./edit-excerpt.js";
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

/** What one step took back in one room: the batch the room commits, and what its receipt says. */
export type TakenRoom = {
  room: DocumentRoom;
  batch: Uint8Array;
  /** The parts the step took in this room. */
  parts: UndoablePart[];
  /** The model's inverse is an edit on its stack: its delta and its edit, which a later Undo reads. */
  model?: { delta: StoredDelta | null; edit: StoredEdit };
  /** It took text out of a draft that Live still holds (an Apply put it there). */
  inManuscript: boolean;
};

/**
 * The reversal policy over one document's history. With room copies (`document.rooms`' `docs`)
 * each `takeOut` takes its parts back on them, so a later step of one command is judged on what
 * the earlier ones leave and commits what they took; the caller owns and frees the copies.
 * Without copies it reads the ledger alone: every part not taken stands, and `takeOut` takes it,
 * which is what an inverse may write, for its admission before it locks.
 */
export function createReversalPlanner(document: InverseDocument, query: TurnInverseQuery) {
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
  /** Whether the part's room is held by a closed owner (an archived draft or Work). */
  const closed = (part: StoredInversePart) => capturedRoom(part.room).closed !== null;
  /**
   * Why a part can't go back now, or null when it goes back (design §2, "An Undo always runs"): an
   * Undo took it already, or its room cut the history it needs.
   */
  const unavailable = (part: StoredInversePart) => {
    if (taken(part)) return "already_removed" as const;
    const docs = capturedRoom(part.room).docs;
    return !part.edit || (docs && !holdsEdit(docs, part.edit)) ? ("compacted" as const) : null;
  };
  // The model's inverse names its turn, as its writes do; the writer's card Undo is the user's.
  const by = query.model && query.turnId ? { turn: query.turnId } : undefined;
  /**
   * Takes `parts` back, newest first as given, each in its room, by design §2's Undo rule
   * (`undoInRooms`): returns the parts that went, how many stay because their room cut their
   * history, and each room's batch and receipt.
   */
  const takeOut = (parts: readonly StoredInversePart[]) => {
    const held = parts.filter(undoable);
    if (!document.copies) return { taken: held, compacted: 0, rooms: [] as TakenRoom[] };
    const docsOf = (room: DocumentRoom) => capturedRoom(room).docs as RoomDocs;
    const before = new Map<
      string,
      {
        since: ReturnType<RoomDocs["shownVersion"]>;
        blocks: ReturnType<typeof blocksIn> | null;
        pending: Set<string> | null;
      }
    >();
    for (const { room } of held) {
      const name = loroRoomName(room);
      if (before.has(name)) continue;
      const docs = docsOf(room);
      before.set(name, {
        since: docs.shownVersion(),
        blocks: query.model ? blocksIn(docs) : null,
        pending: room.kind === "fork" ? pendingBlocks(docs) : null,
      });
    }
    const undone = undoInRooms(held, docsOf, by);
    const went = held.filter((part) => !undone.compacted.has(part));
    const rooms = undone.rooms.map(({ room, changes }): TakenRoom => {
      const name = loroRoomName(room);
      const docs = docsOf(room);
      const was = before.get(name);
      const written = [...new Set(changes.map((change) => change.key))];
      return {
        room,
        batch: encodeChanges(changes),
        parts: went.filter((part) => loroRoomName(part.room) === name),
        ...(was?.blocks
          ? {
              model: {
                delta: captureDelta(was.blocks, blocksIn(docs)),
                edit: editSince(docs, was.since, written),
              },
            }
          : {}),
        // A draft that now differs from Live where it didn't: Live still holds what came out.
        inManuscript: Boolean(
          was?.pending && [...pendingBlocks(docs)].some((id) => !was.pending?.has(id)),
        ),
      };
    });
    // A step whose parts changed nothing records nothing and took nothing.
    return { taken: rooms.length ? went : [], compacted: undone.compacted.size, rooms };
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
  return { own, actions, textPlan, turnTextPlan, takenBy, takeOut, unavailable };
}

const blocksIn = (docs: RoomDocs) =>
  readDocument(docs).map((block) => nodeOf(inverseSchema, block));

/** The blocks a draft's copy holds a change in (`changedBlocks`). */
const pendingBlocks = (docs: RoomDocs) =>
  new Set(changedBlocks(docs).flatMap((change) => change.blocks));
