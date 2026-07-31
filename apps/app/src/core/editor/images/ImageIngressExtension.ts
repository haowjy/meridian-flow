/**
 * ImageIngressExtension — the one place a picture enters a document.
 *
 * Four doors (the toolbar and slash picker, a drop, a pasted file, a pasted
 * address), one lifecycle, and this file is only the wiring: the storage the
 * app registers its ports into, the plugin that holds what is in flight, the
 * clipboard and drop props, and the decorations the manuscript draws from.
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

import { t } from "@lingui/core/macro";
import { type Editor, Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";

import { resolveAnchorIn } from "../anchors";
import { markdownClipboardParser } from "../markdown-paste";
import { tableDropDecision } from "../table-drop";
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
  ingressState,
  sendIngressMessage,
} from "./image-ingress-runtime";
import { createImageIngressStore } from "./image-ingress-store";
import { insertImageFile } from "./image-uploads";
import {
  createEditorAssetPathResolver,
  draggingFiles,
  fileDropIntent,
  imageFileFromClipboard,
  type PastedImageImport,
  pastedContentRange,
  resolveAssetRefsForClipboard,
  resolveImagesFromClipboard,
} from "./image-workflow";
import {
  carryPendingImages,
  orphanedPendingImages,
  pendingImageDecorations,
} from "./pending-images";

/**
 * What every settled document state has to answer for the pictures in flight:
 * which of them the writer has taken back, and which paste is ready to have its
 * links read.
 */
function settlePendingImages(editor: Editor): void {
  if (editor.isDestroyed) return;
  const state = ingressState(editor);

  // A picture the writer moved on from: deleted, or its insert undone. The
  // upload stops, because it has nowhere to land.
  for (const orphan of orphanedPendingImages(state.pending, editor.state)) {
    orphan.abort();
    sendIngressMessage(editor, { drop: orphan.id });
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
      assetIndex: createEditorAssetPathResolver(),
      status: createImageIngressStore(),
      host: null,
    };
  },

  /**
   * The editor is going, so everything it was carrying goes with it.
   *
   * An upload with no editor has nowhere to land: it would finish, write nothing,
   * and leave a project asset no document mentions. The presence plugin releases
   * this client's owner signal on the same teardown
   * (`image-upload-presence.ts`), so peers stop being told a dead tab is still
   * uploading.
   */
  onDestroy() {
    for (const entry of ingressState(this.editor).pending.values()) entry.abort();
    this.storage.status.destroy();
    this.storage.host = null;
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const { assetIndex, status } = this.storage;
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
              // Nothing to carry: an owner elsewhere names a token, and the token
              // travels on the node.
              elsewhere: current.elsewhere,
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
              ? pendingImageDecorations(ingress.pending, ingress.elsewhere, state)
              : null;
          },

          handlePaste(view, event) {
            if (!view.editable) return false;
            const file = imageFileFromClipboard(event);
            if (!file) return false;
            event.preventDefault();
            insertImageFile(editor, file, view.state.selection.from);
            return true;
          },

          handleDrop(view, event) {
            const intent = fileDropIntent(Array.from(event.dataTransfer?.files ?? []));
            if (!intent) return false;
            // Claimed before anything else is decided, including whether the
            // editor can take it: the browser's own answer to a file nobody
            // claimed is to navigate to it, and the manuscript would be gone.
            event.preventDefault();
            status.setDropActive(false);
            if (!view.editable) return true;
            if (intent.kind === "refuse") {
              status.refuse(
                t`${intent.filename} is not an image. Drop a PNG, JPEG, GIF, WEBP, AVIF, or SVG.`,
              );
              return true;
            }
            // The same resolution the dropcursor promised during the drag
            // (`../table-drop.ts`): near a cell border the file lands inside
            // the nearest cell's paragraph, never as a manufactured column.
            const decision = tableDropDecision(view, { x: event.clientX, y: event.clientY });
            if (decision.kind === "refuse") {
              status.refuse(t`A picture cannot go there.`);
              return true;
            }
            const pos =
              decision.kind === "snap"
                ? decision.pos
                : view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            insertImageFile(editor, intent.file, pos);
            return true;
          },

          // Assets travel as stable refs inside the editor and as
          // project-relative paths on the clipboard, so an id never escapes
          // into another surface.
          clipboardTextParser: markdownClipboardParser(undefined, assetIndex),
          transformCopied: (slice) => resolveAssetRefsForClipboard(slice, assetIndex),
          transformPasted: (slice, view) => {
            const resolved = resolveImagesFromClipboard(slice, view.state.schema, assetIndex);
            pasted = resolved.imports.length > 0 ? resolved.imports : null;
            return resolved.slice;
          },

          handleDOMEvents: {
            dragenter(view, event) {
              if (view.editable && draggingFiles(event)) status.setDropActive(true);
              return false;
            },
            dragover(view, event) {
              if (!draggingFiles(event)) return false;
              // The drop is claimed here, before the file's name is knowable:
              // a dragover nobody claims is a drop the browser navigates to.
              // Handed on rather than consumed, so the drop cursor still gets
              // to show where the picture will land.
              event.preventDefault();
              if (view.editable) status.setDropActive(true);
              return false;
            },
            dragleave(_view, event) {
              const leaving = event.currentTarget as HTMLElement | null;
              if (!leaving?.contains(event.relatedTarget as Node)) status.setDropActive(false);
              return false;
            },
          },
        },

        /**
         * Read at the end of the task rather than inside the update itself.
         * Two reasons, and they are the same reason: a plugin must not dispatch
         * from its own `update`, and identity can only be read once the Yjs
         * binding has finished describing the document this transaction
         * produced (`anchors.ts`).
         */
        view: () => ({
          update() {
            if (settleScheduled) return;
            settleScheduled = true;
            queueMicrotask(() => {
              settleScheduled = false;
              settlePendingImages(editor);
            });
          },
        }),
      }),
    ];
  },
});
