/**
 * Each editor's Ctrl+Z undoes only that editor's own edits, even when several editors share one Y.Doc
 * (the Editor tab kept warm and the dock both show a room).
 *
 * y-tiptap tags every editor's local write with the one module-global `ySyncPluginKey` origin, and every
 * editor's UndoManager tracks it, so editor A's history would capture editor B's typing. This extension
 * gives the editor an origin of its own: the patched y-tiptap binding stamps its writes with it as transaction
 * meta, inside the write's transaction (the origin itself cannot change), the UndoManager's `captureTransaction` keeps only stamped writes,
 * and a Discard transacts with the origin directly. The shared room (and its Y.Doc) is untouched; only
 * authorship of undo is per editor.
 */
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";

const ownOrigins = new WeakMap<Y.UndoManager, symbol>();

/** The Yjs origin this editor's own edits carry (a Discard transacts with it), or null without history. */
export function undoOriginOf(undoManager: Y.UndoManager | null | undefined): symbol | null {
  return (undoManager && ownOrigins.get(undoManager)) ?? null;
}

/** An editor's ownership extension and the origin to hand `Collaboration`'s `yUndoOptions.trackedOrigins`. */
export function createUndoOwnership() {
  const origin = Symbol("meridian:editor-edits");
  const extension = Extension.create({
    name: "meridianUndoOwnership",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          view(view) {
            const undoManager: Y.UndoManager = yUndoPluginKey.getState(view.state).undoManager;
            const { binding } = ySyncPluginKey.getState(view.state);
            // A reconfigure (editable flips) re-creates this view over the same retained UndoManager and
            // binding, which already carry the first origin: keep that one.
            if (ownOrigins.has(undoManager)) return {};
            ownOrigins.set(undoManager, origin);

            // The patched binding stamps this key on its own PM-to-Y transaction (see CONTEXT.md).
            binding.ownershipMeta = origin;

            const keepsNonEditorHistory = undoManager.captureTransaction;
            undoManager.captureTransaction = (transaction) =>
              keepsNonEditorHistory(transaction) &&
              // The manager's own undo/redo transactions must pass: that is how they fill the opposite stack.
              (transaction.origin === undoManager ||
                transaction.origin === origin ||
                transaction.meta.get(origin) === true);
            return {};
          },
        }),
      ];
    },
  });
  return { origin, extension };
}
