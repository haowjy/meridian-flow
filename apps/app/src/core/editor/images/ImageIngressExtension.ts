/**
 * ImageIngressExtension — the one place a picture enters a document.
 *
 * Four doors (the toolbar/slash picker, a drop, a pasted file, a pasted
 * address), one lifecycle. The lifecycle is the design's (§5.6) and it is a
 * document lifecycle, not a status report:
 *
 * 1. The `image` node is inserted in its FINAL slot before any byte leaves,
 *    with `src: ""` — the one source that names nothing.
 * 2. Its progress lives in this plugin's state, keyed to that slot by an
 *    `EditorAnchor` (law 9), and reaches the manuscript as a decoration.
 * 3. Landing sets `src` on the same node, so nothing is inserted, nothing is
 *    removed, and no line of prose moves.
 * 4. Failure leaves the node standing with what failed, Retry, and Remove.
 * 5. Deleting the node — by hand, or by undoing the insert — aborts the
 *    upload, because a picture with nowhere to land is not being uploaded.
 *
 * Every upload owns its own entry, so two pictures arriving together are two
 * lifecycles and neither can report the other's progress.
 *
 * The app registers what it alone knows (the project's upload endpoint, the
 * fetch that reads a pasted address) through `registerImageIngressHost`. The
 * asset index lives here because a project-relative path only means something
 * inside one project's namespace, and one editor is one project.
 */

import { t } from "@lingui/core/macro";
import { type Editor, Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import type { DecorationSet } from "@tiptap/pm/view";

import { type AnchorRange, anchorRange, carryAnchor, resolveAnchorIn } from "../anchors";
import { markdownClipboardParser } from "../markdown-paste";
import type { ImageIngressHost, UploadedImage } from "./image-ingress-ports";
import { createImageIngressStore, type ImageIngressStore } from "./image-ingress-store";
import {
  createEditorAssetPathResolver,
  draggingFiles,
  fileDropIntent,
  imageAltFromFilename,
  imageFileFromClipboard,
  imageFilenameFromUrl,
  isImageFile,
  type MutableAssetPathResolver,
  type PastedImageImport,
  pastedContentRange,
  pastedImageLinkRange,
  resolveAssetRefsForClipboard,
  resolveImagesFromClipboard,
} from "./image-workflow";
import { measureImageFile } from "./measure-image";
import {
  carryPendingImages,
  NO_PENDING_IMAGES,
  orphanedPendingImages,
  PENDING_IMAGE_SRC,
  type PendingImage,
  type PendingImageState,
  type PendingImageUpload,
  pendingImageAt,
  pendingImageDecorations,
  resolvePendingImage,
} from "./pending-images";

const IMAGE_INGRESS_NAME = "meridianImageIngress";

type ImageIngressStorage = {
  /** Per-editor: an `asset:` ref only means something in one project. */
  assetIndex: MutableAssetPathResolver;
  /** Drag state and refusals — the two facts no document node can hold. */
  status: ImageIngressStore;
  host: ImageIngressHost | null;
};

declare module "@tiptap/core" {
  interface Storage {
    meridianImageIngress: ImageIngressStorage;
  }
}

/**
 * A paste's imports, waiting to be anchored.
 *
 * The transform that leaves a link behind runs before the transaction exists,
 * so its positions arrive with the paste itself and are carried here until the
 * settled state can pin them: inside `apply` the Yjs binding may still be
 * describing the document the transaction replaced.
 */
type LandingImports = { imports: readonly PastedImageImport[]; range: AnchorRange };

type ImageIngressPluginState = {
  pending: PendingImageState;
  landing: LandingImports | null;
};

type ImageIngressMessage =
  | { set: PendingImage }
  | { drop: string }
  | { landing: LandingImports | null };

const imageIngressPluginKey = new PluginKey<ImageIngressPluginState>(IMAGE_INGRESS_NAME);

const EMPTY_STATE: ImageIngressPluginState = { pending: NO_PENDING_IMAGES, landing: null };

let uploadSequence = 0;

function storageOf(editor: Editor | null | undefined): ImageIngressStorage | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[IMAGE_INGRESS_NAME] ?? null;
}

function pluginStateOf(editor: Editor | null | undefined): ImageIngressPluginState {
  if (!editor || editor.isDestroyed) return EMPTY_STATE;
  return imageIngressPluginKey.getState(editor.state) ?? EMPTY_STATE;
}

/** This editor's asset index, for a surface that translates `asset:` refs. */
export function editorAssetIndex(editor: Editor | null): MutableAssetPathResolver | null {
  return storageOf(editor)?.assetIndex ?? null;
}

/** Drag state and refusals for this editor's ingress, for the app to render. */
export function imageIngressStatus(editor: Editor | null): ImageIngressStore | null {
  return storageOf(editor)?.status ?? null;
}

/**
 * Give this editor somewhere to put pictures. Returns the release, and until it
 * is called this is the one host: a second registration replaces the first,
 * because one editor belongs to one project.
 */
export function registerImageIngressHost(
  editor: Editor | null,
  host: ImageIngressHost,
): () => void {
  const storage = storageOf(editor);
  if (!storage) return () => {};
  storage.host = host;
  return () => {
    if (storage.host === host) storage.host = null;
  };
}

/** Whether a picture can be uploaded at all: law 5's input for the controls. */
export function canUploadImages(editor: Editor | null): boolean {
  const storage = storageOf(editor);
  return Boolean(storage?.host) && Boolean(editor?.isEditable);
}

/** Every picture this editor is waiting on, for tests and surfaces that ask. */
export function pendingImages(editor: Editor | null): readonly PendingImage[] {
  return Array.from(pluginStateOf(editor).pending.values());
}

/**
 * Ask the writer for an image file.
 *
 * The input is created and clicked rather than rendered: a host that has to
 * keep a hidden `<input>` in its tree is a host that owns part of this
 * lifecycle. Refusing out loud when there is no project is the same law-5 rule
 * as the greyed toolbar control — a picker that leads nowhere is worse than a
 * control that says why.
 */
export function openImagePicker(editor: Editor | null): void {
  const storage = storageOf(editor);
  if (!editor || !storage) return;
  if (!editor.isEditable) return;
  if (!storage.host) {
    storage.status.refuse(t`Images need a project before they can be uploaded.`);
    return;
  }
  const input = window.document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.remove();
    if (file) insertImageFile(editor, file);
  });
  // In the document while the chooser is open, out of it afterwards. A detached
  // input's click opens the chooser in Chrome and in nothing else, and a
  // chooser the browser does not report is a chooser no test can answer.
  window.document.body.append(input);
  input.click();
}

/**
 * Put this picture in the document and start sending it.
 *
 * The node lands first and the upload follows, which is the whole point: the
 * writer's slot is theirs from the moment they asked for it, and everything
 * after this is that node's business.
 */
export function insertImageFile(editor: Editor | null, file: File, pos?: number): void {
  const storage = storageOf(editor);
  if (!editor || !storage || !editor.isEditable) return;
  if (!isImageFile(file)) {
    storage.status.refuse(
      t`${file.name} is not an image. Choose a PNG, JPEG, GIF, WEBP, AVIF, or SVG.`,
    );
    return;
  }
  if (!storage.host) {
    storage.status.refuse(t`Images need a project before they can be uploaded.`);
    return;
  }
  const alt = imageAltFromFilename(file.name);
  const at = insertPendingImageNode(editor, alt, pos);
  if (at === null) {
    storage.status.refuse(t`A picture cannot go there.`);
    return;
  }
  startUpload(editor, storage.host, { file, alt, at });
}

/** Send a failed picture again, from the same slot with the same bytes. */
export function retryPendingImage(editor: Editor | null, pos: number): void {
  const storage = storageOf(editor);
  if (!editor || !storage?.host) return;
  const entry = pendingImageAt(pluginStateOf(editor).pending, editor.state, pos);
  if (entry?.kind !== "upload" || entry.status.kind !== "failed") return;
  const controller = new AbortController();
  const retried: PendingImageUpload = {
    ...entry,
    status: { kind: "uploading", percent: null },
    abort: () => controller.abort(),
  };
  send(editor, { set: retried });
  void runUpload(editor, storage.host, retried.id, controller.signal);
}

/** Take the picture back out. Whatever was in flight for it stops. */
export function removePendingImage(editor: Editor | null, pos: number): void {
  if (!editor || editor.isDestroyed) return;
  const entry = pendingImageAt(pluginStateOf(editor).pending, editor.state, pos);
  if (entry?.kind !== "upload") return;
  entry.abort();
  const transaction = editor.state.tr.delete(pos, pos + 1);
  transaction.setMeta(imageIngressPluginKey, { drop: entry.id } satisfies ImageIngressMessage);
  editor.view.dispatch(transaction);
}

/**
 * The picture's slot, opened where the writer asked for it.
 *
 * `image` is an inline atom (§5.6), so where it can sit is a schema question
 * and not a preference: inside a paragraph it goes between the words, and
 * anywhere that cannot hold an inline picture (the seam between blocks, a code
 * fence) it arrives in a paragraph of its own after that block. Null is the
 * refusal, for a position that can take neither.
 */
function insertPendingImageNode(editor: Editor, alt: string, pos?: number): number | null {
  const { state } = editor;
  const imageType = state.schema.nodes.image;
  const paragraphType = state.schema.nodes.paragraph;
  if (!imageType || !paragraphType) return null;

  const target = Math.max(0, Math.min(pos ?? state.selection.from, state.doc.content.size));
  const image = imageType.create({ src: PENDING_IMAGE_SRC, alt, title: null });
  const $target = state.doc.resolve(target);
  const transaction = state.tr;
  let imagePos: number;

  if ($target.parent.canReplaceWith($target.index(), $target.index(), imageType)) {
    transaction.insert(target, image);
    imagePos = target;
  } else {
    const seam = $target.depth === 0 ? target : $target.after($target.depth);
    const $seam = state.doc.resolve(seam);
    if (!$seam.parent.canReplaceWith($seam.index(), $seam.index(), paragraphType)) return null;
    transaction.insert(seam, paragraphType.create(null, image));
    imagePos = seam + 1;
  }

  // The caret lands after the picture: the writer asked for an image mid
  // sentence and the sentence continues.
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(imagePos + 1)));
  transaction.scrollIntoView();
  editor.view.dispatch(transaction);
  return imagePos;
}

function startUpload(
  editor: Editor,
  host: ImageIngressHost,
  input: { file: File; alt: string; at: number },
): void {
  const controller = new AbortController();
  uploadSequence += 1;
  const id = `image-upload:${uploadSequence}`;
  const entry: PendingImageUpload = {
    kind: "upload",
    id,
    hold: anchorRange(editor.state, { from: input.at, to: input.at + 1 }),
    filename: input.file.name,
    alt: input.alt,
    file: input.file,
    frame: null,
    status: { kind: "uploading", percent: null },
    abort: () => controller.abort(),
  };
  send(editor, { set: entry });

  // The frame's shape comes from the file itself, so the slot is the picture's
  // real slot before a single byte has arrived.
  void measureImageFile(input.file).then((frame) => {
    if (!frame) return;
    patchUpload(editor, id, (current) => ({ ...current, frame }));
  });

  void runUpload(editor, host, id, controller.signal);
}

async function runUpload(
  editor: Editor,
  host: ImageIngressHost,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  const entry = uploadEntry(editor, id);
  if (!entry) return;
  try {
    const uploaded = await host.upload({
      file: entry.file,
      alt: entry.alt,
      signal,
      onProgress: (percent) =>
        patchUpload(editor, id, (current) =>
          current.status.kind === "uploading" && current.status.percent === percent
            ? current
            : { ...current, status: { kind: "uploading", percent } },
        ),
    });
    if (signal.aborted) return;
    landUpload(editor, id, uploaded);
  } catch (error) {
    // An abort is the writer taking the picture back, not a failure to report.
    if (signal.aborted) return;
    patchUpload(editor, id, (current) => ({
      ...current,
      status: {
        kind: "failed",
        message: error instanceof Error ? error.message : t`That image did not upload.`,
      },
    }));
  }
}

/**
 * The bytes arrived: the picture's own node becomes the picture.
 *
 * One transaction, one attribute. Nothing is inserted and nothing is removed,
 * which is why the manuscript does not move — and the fence is re-read here
 * because an upload outlives the connection that started it.
 */
function landUpload(editor: Editor, id: string, uploaded: UploadedImage): void {
  const storage = storageOf(editor);
  const entry = uploadEntry(editor, id);
  if (!editor || editor.isDestroyed || !storage || !entry) return;
  const at = resolvePendingImage(editor.state, entry);
  // The slot is gone, so there is nothing to land in. The asset stays in the
  // project, which is where the writer put it.
  if (!at) {
    send(editor, { drop: id });
    return;
  }
  if (!editor.isEditable) {
    patchUpload(editor, id, (current) => ({
      ...current,
      status: { kind: "failed", message: t`This document is not taking changes right now.` },
    }));
    return;
  }
  storage.assetIndex.remember(uploaded.assetDocumentId, uploaded.assetPath);
  const node = editor.state.doc.nodeAt(at.from) as PMNode;
  const transaction = editor.state.tr.setNodeMarkup(at.from, undefined, {
    ...node.attrs,
    src: uploaded.src,
    alt: uploaded.alt ?? entry.alt,
  });
  // Undo removes the picture the writer inserted; it does not step back through
  // the arrival of its own bytes and leave an empty frame behind.
  transaction.setMeta("addToHistory", false);
  transaction.setMeta(imageIngressPluginKey, { drop: id } satisfies ImageIngressMessage);
  editor.view.dispatch(transaction);
}

/**
 * Bring a picture the clipboard only pointed at into the project.
 *
 * The paste already landed a link to the address, so the manuscript never holds
 * a `src` the project does not own. This is the attempt to do better than the
 * link: read the bytes, put them through the same upload a dropped file takes,
 * and replace the link with the picture. A site that refuses the fetch leaves
 * the link exactly where it is, which is the honest end state.
 */
function startImport(editor: Editor, pending: PastedImageImport, at: AnchorRange): void {
  const storage = storageOf(editor);
  if (!storage?.host) return;
  const link = pastedImageLinkRange(editor.state.doc, at, pending.url);
  if (!link) return;

  const controller = new AbortController();
  uploadSequence += 1;
  const id = `image-import:${uploadSequence}`;
  const filename = imageFilenameFromUrl(pending.url);
  send(editor, {
    set: {
      kind: "import",
      id,
      hold: anchorRange(editor.state, link),
      url: pending.url,
      filename,
      abort: () => controller.abort(),
    },
  });

  const host = storage.host;
  void (async () => {
    try {
      const file = await host.fetchBytes({ url: pending.url, filename, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!file) {
        storage.status.refuse(t`${filename} could not be read from that site. It stayed a link.`);
        send(editor, { drop: id });
        return;
      }
      const uploaded = await host.upload({
        file,
        alt: pending.alt ?? imageAltFromFilename(filename),
        signal: controller.signal,
        onProgress: () => {},
      });
      if (controller.signal.aborted) return;
      landImport(editor, id, uploaded);
    } catch (error) {
      if (controller.signal.aborted) return;
      storage.status.refuse(
        error instanceof Error ? error.message : t`${filename} did not import. It stayed a link.`,
      );
      send(editor, { drop: id });
    }
  })();
}

function landImport(editor: Editor, id: string, uploaded: UploadedImage): void {
  const storage = storageOf(editor);
  if (!editor || editor.isDestroyed || !storage) return;
  const entry = pluginStateOf(editor).pending.get(id);
  if (!entry || entry.kind !== "import") return;
  const link = resolvePendingImage(editor.state, entry);
  const imageType = editor.state.schema.nodes.image;
  if (!link || !imageType || !editor.isEditable) {
    if (!link) storage.status.refuse(t`${entry.filename} imported, but its link had moved on.`);
    send(editor, { drop: id });
    return;
  }
  storage.assetIndex.remember(uploaded.assetDocumentId, uploaded.assetPath);
  const transaction = editor.state.tr.replaceWith(
    link.from,
    link.to,
    imageType.create({ src: uploaded.src, alt: uploaded.alt, title: null }),
  );
  transaction.setMeta(imageIngressPluginKey, { drop: id } satisfies ImageIngressMessage);
  editor.view.dispatch(transaction);
}

/**
 * What every settled document state has to answer for the pictures in flight:
 * which of them the writer has taken back, and which paste is ready to have its
 * links read.
 */
function settlePendingImages(editor: Editor): void {
  if (editor.isDestroyed) return;
  const state = pluginStateOf(editor);

  // A picture the writer moved on from: deleted, or its insert undone. The
  // upload stops, because it has nowhere to land.
  for (const orphan of orphanedPendingImages(state.pending, editor.state)) {
    orphan.abort();
    send(editor, { drop: orphan.id });
  }

  if (!state.landing) return;
  const { imports, range } = state.landing;
  send(editor, { landing: null });
  const at = resolveAnchorIn(editor.state, { ...range, relative: null });
  // Started together, so every import anchors the range at the one moment it is
  // true: the instant the paste landed.
  if (at) for (const pending of imports) startImport(editor, pending, at);
}

function uploadEntry(editor: Editor, id: string): PendingImageUpload | null {
  const entry = pluginStateOf(editor).pending.get(id);
  return entry?.kind === "upload" ? entry : null;
}

function patchUpload(
  editor: Editor,
  id: string,
  next: (current: PendingImageUpload) => PendingImageUpload,
): void {
  const current = uploadEntry(editor, id);
  if (!current) return;
  const updated = next(current);
  if (updated !== current) send(editor, { set: updated });
}

/**
 * Tell the document about a pending picture. Meta only: no step reaches Yjs, so
 * a percent is not an edit and never enters anyone's undo history.
 */
function send(editor: Editor, message: ImageIngressMessage): void {
  if (editor.isDestroyed) return;
  const transaction = editor.state.tr.setMeta(imageIngressPluginKey, message);
  transaction.setMeta("addToHistory", false);
  editor.view.dispatch(transaction);
}

/**
 * Carry a paste's own coordinates across one mapping.
 *
 * Plain numbers rather than a relative anchor: this lives for the length of one
 * task, from the paste's transaction to the settled state that pins its links,
 * and a mapping is exactly the right instrument over that span.
 */
function carryLanding(landing: LandingImports | null, mapping: Mappable): LandingImports | null {
  if (!landing) return null;
  const carried = carryAnchor({ ...landing.range, relative: null }, mapping);
  return carried
    ? { imports: landing.imports, range: { from: carried.from, to: carried.to } }
    : null;
}

function applyMessage(
  current: ImageIngressPluginState,
  message: ImageIngressMessage,
): ImageIngressPluginState {
  if ("landing" in message) return { ...current, landing: message.landing };
  const pending = new Map(current.pending);
  if ("drop" in message) pending.delete(message.drop);
  else pending.set(message.set.id, message.set);
  return { ...current, pending };
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

  onDestroy() {
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
          init: () => EMPTY_STATE,
          apply(transaction, current) {
            const message = transaction.getMeta(imageIngressPluginKey) as
              | ImageIngressMessage
              | undefined;
            const carried: ImageIngressPluginState = {
              pending: carryPendingImages(current.pending, transaction.mapping),
              landing: carryLanding(current.landing, transaction.mapping),
            };
            return message ? applyMessage(carried, message) : carried;
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
            const pending = imageIngressPluginKey.getState(state)?.pending;
            return pending ? pendingImageDecorations(pending, state) : null;
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
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
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
