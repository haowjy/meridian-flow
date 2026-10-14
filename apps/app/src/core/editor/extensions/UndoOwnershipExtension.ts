/**
 * Each editor's Ctrl+Z undoes only that editor's own edits, even when several editors share one Y.Doc
 * (the Editor tab kept warm and the dock both show a room), and the history outlives the editor instance.
 *
 * y-tiptap tags every editor's local write with the one module-global `ySyncPluginKey` origin, and every
 * editor's UndoManager tracks it, so editor A's history would capture editor B's typing. A surface's
 * `SurfaceHistory` gives it an origin of its own: the patched y-tiptap binding stamps its writes with it as
 * transaction meta, inside the write's transaction (the origin itself cannot change), the UndoManager's
 * `captureTransaction` keeps only stamped writes, and a Discard transacts with the origin directly. The shared
 * room (and its Y.Doc) is untouched; only authorship of undo is per surface.
 *
 * The history belongs to the room's session, not to the editor: a handoff between the Editor and the dock
 * rebuilds the editor (its UndoManager would die with it), so the session keeps one history per surface and
 * every editor that surface mounts over the room adopts it. Collaboration detaches a retained manager on
 * view destroy and re-attaches it on the next view.
 */
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import {
  defaultDeleteFilter,
  defaultProtectedNodes,
  ySyncPluginKey,
  yUndoPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";

const ownOrigins = new WeakMap<Y.UndoManager, symbol>();

/** One surface's undo history over one room, and the Yjs origin its edits carry. */
export type SurfaceHistory = { readonly undoManager: Y.UndoManager; readonly origin: symbol };

/** The Yjs origin this editor's own edits carry (a Discard transacts with it), or null without history. */
export function undoOriginOf(undoManager: Y.UndoManager | null | undefined): symbol | null {
  return (undoManager && ownOrigins.get(undoManager)) ?? null;
}

/** A fresh history over `fragment`; the room's session keeps one per surface for as long as the room is open. */
export function createSurfaceHistory(fragment: Y.XmlFragment): SurfaceHistory {
  const origin = Symbol("meridian:editor-edits");
  const undoManager: Y.UndoManager = new Y.UndoManager(fragment, {
    trackedOrigins: new Set([ySyncPluginKey, origin]),
    deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
    captureTransaction: (transaction): boolean =>
      transaction.meta.get("addToHistory") !== false &&
      // The manager's own undo/redo transactions must pass: that is how they fill the opposite stack.
      (transaction.origin === undoManager ||
        transaction.origin === origin ||
        transaction.meta.get(origin) === true),
  });
  ownOrigins.set(undoManager, origin);
  return { undoManager, origin };
}

/** An editor's ownership extension over a surface's history, and the options to hand `Collaboration`'s `yUndoOptions`. */
export function createUndoOwnership(history: SurfaceHistory) {
  const extension = Extension.create({
    name: "meridianUndoOwnership",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          view(view) {
            // The patched binding stamps this key on its own PM-to-Y transaction (see CONTEXT.md). Every
            // editor over the history has a binding of its own, so each one is claimed afresh.
            const { binding } = ySyncPluginKey.getState(view.state);
            binding.ownershipMeta = ownOrigins.get(yUndoPluginKey.getState(view.state).undoManager);
            return {};
          },
        }),
      ];
    },
  });
  return { extension, yUndoOptions: { undoManager: history.undoManager } };
}
