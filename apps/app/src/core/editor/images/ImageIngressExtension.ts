/**
 * ImageIngressExtension — the one place a picture enters a document.
 *
 * Four doors (the toolbar and slash picker, a drop, a pasted file, a pasted
 * address), one lifecycle, and this file is only the wiring: the storage the
 * app registers its ports into, the plugin that holds what is in flight, the
 * clipboard prop (a drop lands through `file-drop/file-drop-door.ts`), and the decorations the manuscript draws from.
 *
 * The lifecycle itself is next door — [`image-uploads.ts`](image-uploads.ts) for
 * a picture from this machine, [`image-imports.ts`](image-imports.ts) for one the
 * clipboard pointed at — and what the document knows about a picture in flight
 * is [`pending-images.ts`](pending-images.ts).
 *
 * The rule the whole lane rests on: the `image` node stands in its FINAL slot
 * before any byte leaves, so the writer can move it, delete it, type around it
 * and undo it like any other node, and completion never reflows the manuscript.
 */

import { type Editor, Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";

import { uploads } from "@/core/uploads/upload-store";

import { resolveAnchorIn } from "../anchors";
import { wikilinkPasteParsePlugins } from "../links";
import { markdownClipboardParser, markdownClipboardSerializer } from "../markdown-paste";
import { startImageImport } from "./image-imports";
import {
  applyIngressMessage,
  carryLanding,
  EMPTY_INGRESS_STATE,
  IMAGE_INGRESS_NAME,
  type ImageIngressMessage,
  type ImageIngressPluginState,
  type ImageIngressStorage,
  imageIngressPluginKey,
  imageIngressStorage,
  ingressState,
  sendIngressMessage,
} from "./image-ingress-runtime";
import { createImageIngressStore } from "./image-ingress-store";
import { pasteImageFile } from "./image-uploads";
import {
  imageFileFromClipboard,
  linkExternalPastedImages,
  type PastedImageImport,
  pastedContentRange,
} from "./image-workflow";
import {
  carryPendingImages,
  finishedPendingImages,
  pendingImageDecorations,
  uploadTokensIn,
} from "./pending-images";

/**
 * What every settled document state has to answer for the pictures in flight:
 * which of them are over, and which paste is ready to have its links read.
 */
function settlePendingImages(editor: Editor): void {
  if (editor.isDestroyed) return;
  const state = ingressState(editor);

  // An import whose link the writer moved on from stops, because it has nowhere to land. An
  // upload is the store's to stop (`upload-store.ts`); its record here goes when the store's does.
  for (const done of finishedPendingImages(state.pending, editor.state)) {
    if (done.kind === "import") done.abort();
    sendIngressMessage(editor, { drop: done.id });
  }

  if (!state.landing) return;
  const { imports, range } = state.landing;
  sendIngressMessage(editor, { landing: null });
  const at = resolveAnchorIn(editor.state, { ...range, relative: null });
  // Started together, so every import anchors the range at the one moment it is
  // true: the instant the paste landed.
  if (at) for (const pending of imports) startImageImport(editor, pending, at);
}
export const ImageIngressExtension = Extension.create({
  name: IMAGE_INGRESS_NAME,

  addStorage(): ImageIngressStorage {
    return {
      status: createImageIngressStore(),
      host: null,
      holder: crypto.randomUUID(),
      watch: null,
    };
  },

  onCreate() {
    const { editor, storage } = this;
    storage.watch = uploads.watch(storage.holder, () =>
      editor.isDestroyed ? new Set() : uploadTokensIn(editor.state.doc),
    );
  },

  /**
   * The editor is going, so everything it was carrying goes with it.
   *
   * A picture lands through the editor that sent it: with no editor it would
   * finish, write nothing, and leave a project asset no document mentions. The
   * presence plugin releases this client's owner signal on the same teardown
   * (`upload-presence.ts`), so peers stop being told a dead tab is still
   * uploading.
   */
  onDestroy() {
    for (const entry of ingressState(this.editor).pending.values()) {
      if (entry.kind === "upload") uploads.discard(entry.id);
      else entry.abort();
    }
    this.storage.watch?.release();
    this.storage.watch = null;
    this.storage.status.destroy();
    this.storage.host = null;
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    /** Imports a paste asked for, between the transform and its transaction. */
    let pasted: readonly PastedImageImport[] | null = null;
    let settleScheduled = false;

    return [
      new Plugin<ImageIngressPluginState>({
        key: imageIngressPluginKey,

        state: {
          init: () => EMPTY_INGRESS_STATE,
          apply(transaction, current) {
            const message = transaction.getMeta(imageIngressPluginKey) as
              | ImageIngressMessage
              | undefined;
            const carried: ImageIngressPluginState = {
              pending: carryPendingImages(current.pending, transaction.mapping),
              landing: carryLanding(current.landing, transaction.mapping),
            };
            return message ? applyIngressMessage(carried, message) : carried;
          },
        },

        /**
         * The paste is the only thing that knows where its own content went:
         * the transform runs before the transaction exists, and the selection
         * afterwards says only where the content ended.
         */
        appendTransaction(transactions, _oldState, newState) {
          const imports = pasted;
          pasted = null;
          if (!imports || imports.length === 0) return null;
          const paste = transactions.filter((candidate) => candidate.docChanged).at(-1);
          const range = paste ? pastedContentRange(paste) : null;
          if (!range) return null;
          const transaction = newState.tr.setMeta(imageIngressPluginKey, {
            landing: { imports, range },
          } satisfies ImageIngressMessage);
          transaction.setMeta("addToHistory", false);
          return transaction;
        },

        props: {
          decorations(state): DecorationSet | null {
            const ingress = imageIngressPluginKey.getState(state);
            return ingress
              ? pendingImageDecorations(
                  ingress.pending,
                  state,
                  ingress.pending.size > 0 || uploads.anyPeerSending(),
                )
              : null;
          },

          handlePaste(view, event) {
            if (!view.editable) return false;
            const file = imageFileFromClipboard(event);
            if (!file) return false;
            // A file carries no slice, so no handler behind this one — the
            // table sweep plugin included — could ever answer it. What the
            // paste MEANS is still not decided here: `pasteImageFile` lands a
            // sweep through the sweep module's own replace, a caret inline.
            event.preventDefault();
            pasteImageFile(editor, file);
            return true;
          },

          clipboardTextParser: markdownClipboardParser(undefined, () =>
            wikilinkPasteParsePlugins(editor),
          ),
          clipboardTextSerializer: markdownClipboardSerializer,
          transformPasted: (slice, view) => {
            // A drag moves pictures the editor already holds, as stored.
            if (view.dragging) {
              pasted = null;
              return slice;
            }
            const linked = linkExternalPastedImages(slice, view.state.schema);
            pasted = linked.imports.length > 0 ? linked.imports : null;
            return linked.slice;
          },
        },

        /**
         * Read at the end of the task rather than inside the update itself.
         * Two reasons, and they are the same reason: a plugin must not dispatch
         * from its own `update`, and identity can only be read once the Yjs
         * binding has finished describing the document this transaction
         * produced (`anchors.ts`).
         */
        view: () => {
          let redraw = false;
          const scheduleSettle = () => {
            if (settleScheduled) return;
            settleScheduled = true;
            queueMicrotask(() => {
              settleScheduled = false;
              settlePendingImages(editor);
              if (!redraw || editor.isDestroyed) return;
              redraw = false;
              sendIngressMessage(editor, { redraw: true });
            });
          };
          // A slot's status is the upload store's: when it moves, the slot is drawn again.
          const unsubscribe = uploads.subscribe((changed) => {
            if (editor.isDestroyed) return;
            const { pending } = ingressState(editor);
            if (![...changed].some((id) => pending.has(id))) return;
            redraw = true;
            scheduleSettle();
          });
          return {
            update(view, previous) {
              if (view.state.doc !== previous.doc) imageIngressStorage(editor)?.watch?.changed();
              const { pending, landing } = ingressState(editor);
              if (pending.size > 0 || landing) scheduleSettle();
            },
            destroy: unsubscribe,
          };
        },
      }),
    ];
  },
});
