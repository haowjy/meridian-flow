/**
 * Discard of a draft nobody has open: the same local edit the open review makes (`writeDiscard`, so the
 * blocks a Discard writes are decided in one place), applied to the draft room's text, with a
 * `Y.UndoManager` that tracks only this edit. Undo reverts exactly the discard and leaves the writer's
 * later typing; the history is the caller's to keep for the session and gone with it.
 */
import { recordRestorations } from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { refindGroup, writeDiscard } from "./draft-discard";
import { locateInRoom, projectRoom, type ReviewFrame } from "./review-frame";

/** `release` ends the history without reverting: the Discard stays, Undo is gone. */
export type RoomDiscard = { undo: () => void; release: () => void };

/** A change as the row the writer clicked drew it: its id there, and the place it was pinned at (`projectRoom`). */
export type ClickedChange = { id: string; pin: Y.RelativePosition };

/**
 * Revert these change ids (or every change) of the room's text as it is now. Null when an id is not in
 * the room's changes: the room moved on, and a stale id is not the change the writer clicked.
 */
export function discardInRoom(doc: Y.Doc, which: readonly string[] | "all"): RoomDiscard | null {
  const projection = projectRoom(doc);
  if (which !== "all" && !which.every((id) => projection.groups.some((group) => group.id === id)))
    return null;
  return writeInRoom(doc, projection, which);
}

/**
 * Revert the change the writer clicked. Its id was ranked in an older projection, so the room may have moved
 * on (a peer removed an identical change and the survivor took its id): it is found again by its pinned
 * position plus its content, as the editor's Discard does, and refused when it cannot be.
 */
export function discardClickedChange(doc: Y.Doc, clicked: ClickedChange): RoomDiscard | null {
  const projection = projectRoom(doc);
  const at = locateInRoom(doc, clicked.pin);
  const group = refindGroup(projection, clicked.id, at);
  return group ? writeInRoom(doc, projection, [group.id]) : null;
}

function writeInRoom(
  doc: Y.Doc,
  projection: ReviewFrame,
  which: readonly string[] | "all",
): RoomDiscard {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const origin = Symbol("meridian:room-discard");
  const history = new Y.UndoManager(fragment, {
    trackedOrigins: new Set([origin]),
    captureTimeout: 0,
  });
  recordRestorations(history);
  try {
    writeDiscard(
      { doc, fragment, schema: buildDocumentSchema(), undo: history, origin },
      projection,
      which,
    );
  } catch (error) {
    history.destroy();
    throw error;
  }
  return {
    undo: () => {
      history.undo();
      history.destroy();
    },
    release: () => {
      history.clear();
      history.destroy();
    },
  };
}
