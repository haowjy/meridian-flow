import type { ImportStatus, LoroDoc } from "loro-crdt";
import type { EditorView } from "prosemirror-view";

/**
 * The composition guard. A remote update that arrives while an editor on its document is in an
 * IME composition is held, as bytes, and imported once the composition ends.
 *
 * Holding the bytes, not just the editor's view of them, is what keeps the binding's one
 * invariant: between transactions the ProseMirror document is what the LoroDoc holds. Every
 * local write (the fast path's offsets, the reconciliation's mapping) is computed against that.
 * Importing during the composition and holding only the editor update would leave Loro ahead
 * of ProseMirror, and the composition's own keystrokes would then be written against the wrong
 * text: inserted at a stale offset, or a remote block deleted as "not in the editor".
 *
 * An import that doesn't come through `importRemoteUpdate` is applied at once, composition or not.
 */
type Hold = { views: Set<EditorView>; queued: Uint8Array[]; releasing: boolean };

const holds = new WeakMap<LoroDoc, Hold>();

function holdFor(doc: LoroDoc): Hold {
  let hold = holds.get(doc);
  if (hold == null) {
    hold = { views: new Set(), queued: [], releasing: false };
    holds.set(doc, hold);
  }
  return hold;
}

/**
 * Import a peer's update into `doc`, or hold it while an editor bound to `doc` is composing.
 * Returns the import status, or null when the update was held. Held updates keep their order
 * and are imported together, as one event, when the last composition on `doc` ends.
 */
export function importRemoteUpdate(doc: LoroDoc, bytes: Uint8Array): ImportStatus | null {
  const hold = holds.get(doc);
  if (hold != null && (hold.queued.length > 0 || composing(hold))) {
    hold.queued.push(bytes);
    return null;
  }
  return doc.import(bytes);
}

/** How many remote updates are held for `doc` right now. */
export function heldUpdateCount(doc: LoroDoc): number {
  return holds.get(doc)?.queued.length ?? 0;
}

function composing(hold: Hold): boolean {
  for (const view of hold.views) if (!view.isDestroyed && view.composing) return true;
  return false;
}

/**
 * Bind `view` to `doc`'s hold. The release waits for ProseMirror to read the composition's last
 * DOM change into its state: it runs from a timer after `compositionend`, and again from every
 * view update, and only when no view on the document is composing.
 */
export function attachCompositionHold(doc: LoroDoc, view: EditorView) {
  const hold = holdFor(doc);
  hold.views.add(view);
  const schedule = () => {
    if (hold.queued.length === 0 || hold.releasing) return;
    hold.releasing = true;
    setTimeout(() => {
      hold.releasing = false;
      release(doc, hold);
    }, 0);
  };
  view.dom.addEventListener("compositionend", schedule);
  return {
    update: () => {
      if (!view.composing) schedule();
    },
    destroy: () => {
      view.dom.removeEventListener("compositionend", schedule);
      hold.views.delete(view);
      release(doc, hold);
    },
  };
}

function release(doc: LoroDoc, hold: Hold) {
  if (hold.queued.length === 0 || composing(hold)) return;
  const queued = hold.queued;
  hold.queued = [];
  doc.importBatch(queued);
}
