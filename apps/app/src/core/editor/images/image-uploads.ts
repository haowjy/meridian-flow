/** Runs image upload and replacement commands. */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { uploads } from "@/core/uploads/upload-store";
import {
  anchorRange,
  type EditorAnchor,
  holdNode,
  type NodeHold,
  resolveAnchorIn,
  resolveNodeHold,
} from "../anchors";
import type { Landing } from "../landing/point-landing";

import { objectSurfaceKind } from "../objects";
import { sweepReplaceLanding } from "../table-sweep-paste";
import type { ImageIngressHost, UploadedImage } from "./image-ingress-ports";
import {
  type ImageIngressMessage,
  imageIngressPluginKey,
  imageIngressStorage,
  ingressState,
  patchUpload,
  sendIngressMessage,
  uploadEntry,
} from "./image-ingress-runtime";
import { acceptsInlineImage, imageAltFromFilename, isImageFile } from "./image-workflow";
import { measureImageFile } from "./measure-image";
import {
  PENDING_IMAGE_SRC,
  type PendingImageUpload,
  pendingImageAt,
  resolvePendingImage,
  UPLOAD_TOKEN_ATTR,
} from "./pending-images";

/** Ask the writer for an image file, and hand it to whoever asked. */
function pickImageFile(onFile: (file: File) => void): void {
  const input = window.document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.remove();
    if (file) onFile(file);
  });
  // In the document while the chooser is open, out of it afterwards. A detached
  // input's click opens the chooser in Chrome and in nothing else, and a
  // chooser the browser does not report is a chooser no test can answer.
  window.document.body.append(input);
  input.click();
}

/** Is there anywhere for a picture to go? */
function ingressHost(editor: Editor | null): ImageIngressHost | null {
  const storage = imageIngressStorage(editor);
  if (!editor || !storage || !editor.isEditable) return null;
  if (!storage.host) {
    storage.status.refuse(t`Images need a project before they can be uploaded.`);
    return null;
  }
  return storage.host;
}

/** Where a picture the writer is about to choose goes. */
export type ImagePickerTarget =
  /** A new picture at a place in the prose. */
  | { kind: "insert"; at: EditorAnchor }
  /** Another picture for a slot the writer already placed. */
  | { kind: "replace"; slot: NodeHold };

/** A new picture where the caret is now, pinned before the chooser opens. */
export function imageCaretTarget(editor: Editor | null): ImagePickerTarget | null {
  if (!editor || editor.isDestroyed) return null;
  // Select-all leaves a selection that starts at the document's edge, outside
  // every block; the nearest place a caret can stand is where the picture goes.
  const at = Selection.near(editor.state.selection.$from).from;
  return { kind: "insert", at: anchorRange(editor.state, { from: at, to: at }) };
}

/**
 * The picture at `pos`, for's Replace verb (on the object surface's ⋮), or
 * null when nothing starts there.
 */
export function imageReplaceTarget(editor: Editor | null, pos: number): ImagePickerTarget | null {
  if (!editor || editor.isDestroyed) return null;
  const slot = holdNode(editor.state, pos);
  return slot && { kind: "replace", slot };
}

/** Ask the writer for a picture, and put it where the target says. */
export function openImagePicker(editor: Editor | null, target: ImagePickerTarget | null): void {
  if (!editor || !target || !ingressHost(editor)) return;
  pickImageFile((file) =>
    target.kind === "replace"
      ? replaceImageFile(editor, target.slot, file)
      : insertImageAtAnchor(editor, target.at, file),
  );
}

/** A new picture at the place the writer asked from, however far the document has moved since. */
function insertImageAtAnchor(editor: Editor, anchor: EditorAnchor, file: File): void {
  const storage = imageIngressStorage(editor);
  if (!storage) return;
  const at = resolveAnchorIn(editor.state, anchor);
  if (!at || !acceptsInlineImage(editor.state.doc, at.from)) {
    storage.status.refuse(t`There is nowhere left to put that picture.`);
    return;
  }
  insertImageFile(editor, file, { kind: "inline", pos: at.from });
}

/** Another picture for a slot the writer already placed. */
function replaceImageFile(editor: Editor | null, target: NodeHold, file: File): void {
  const storage = imageIngressStorage(editor);
  const host = ingressHost(editor);
  if (!editor || !storage || !host) return;
  if (!isImageFile(file)) {
    storage.status.refuse(
      t`${file.name} is not an image. Choose a PNG, JPEG, GIF, WEBP, AVIF, or SVG.`,
    );
    return;
  }
  const at = resolveNodeHold(editor.state, target);
  const node = at && editor.state.doc.nodeAt(at.from);
  // Read back rather than trusted: the hold answers where its node is, and the
  // registration answers whether that node is still something a picture can go
  // into (a figure counts, and so does the inline picture). Nothing is opened
  // for a slot that went away while the chooser was up — no entry, no request,
  // and no asset the project has no use for.
  if (!at || !node || objectSurfaceKind(node) !== "image") {
    storage.status.refuse(t`That picture is no longer in the document.`);
    return;
  }
  // The writer's own alt text outlives the picture it described only if they
  // wrote one; a slot that never had one takes the new file's name, as an insert
  // does.
  const existing = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const id = openUpload(editor, {
    file,
    alt: existing || imageAltFromFilename(file.name),
    landing: "replace",
  });
  // Bookkeeping rather than an edit, so it stays out of the writer's undo stack:
  // what they will undo is the picture, and that is the landing's business.
  writeSlot(editor, at.from, { [UPLOAD_TOKEN_ATTR]: id }, { history: false });
  sendUpload(editor, host, id, file);
}

/** Put this picture in the document and start sending it. */
export function insertImageFile(editor: Editor | null, file: File, at: Landing): void {
  openImageFileUpload(editor, file, (target, alt, token) =>
    insertPendingImageNode(target, alt, token, at),
  );
}

/** An image file arriving from the clipboard — the paste door's one decision. */
export function pasteImageFile(editor: Editor | null, file: File): void {
  if (!editor || editor.isDestroyed) return;
  if (editor.state.selection instanceof CellSelection) {
    openImageFileUpload(editor, file, insertPendingImageInSweep);
    return;
  }
  const { from } = editor.state.selection;
  // A selection that cannot hold a picture (code) puts it after its block.
  insertImageFile(editor, file, {
    kind: acceptsInlineImage(editor.state.doc, from) ? "inline" : "source",
    pos: from,
  });
}

/** One lifecycle for a picture file with somewhere to go: validate the file, open the upload, let `place` land the slot, and start the bytes. */
function openImageFileUpload(
  editor: Editor | null,
  file: File,
  place: (editor: Editor, alt: string, token: string) => number | null,
): void {
  const storage = imageIngressStorage(editor);
  if (!editor || !storage || !editor.isEditable) return;
  if (!isImageFile(file)) {
    storage.status.refuse(
      t`${file.name} is not an image. Choose a PNG, JPEG, GIF, WEBP, AVIF, or SVG.`,
    );
    return;
  }
  const host = ingressHost(editor);
  if (!host) return;
  const alt = imageAltFromFilename(file.name);
  const id = openUpload(editor, { file, alt, landing: "insert" });
  const at = place(editor, alt, id);
  if (at === null) {
    sendIngressMessage(editor, { drop: id });
    storage.status.refuse(t`A picture cannot go there.`);
    return;
  }
  sendUpload(editor, host, id, file);
}

/** Send a failed picture again, from the same slot with the same bytes. */
export function retryPendingImage(editor: Editor | null, pos: number): void {
  if (!editor || editor.isDestroyed) return;
  const entry = pendingImageAt(ingressState(editor).pending, editor.state, pos);
  if (entry?.kind === "upload") uploads.retry(entry.id);
}

/**
 * Take the picture back out. Its upload stops as any slot's does when it leaves the text, so an
 * undo brings it back still sending, or ready to retry.
 */
export function removePendingImage(editor: Editor | null, pos: number): void {
  if (!editor || editor.isDestroyed) return;
  const entry = pendingImageAt(ingressState(editor).pending, editor.state, pos);
  if (entry?.kind !== "upload") return;
  editor.view.dispatch(editor.state.tr.delete(pos, pos + 1));
}

/**
 * The picture's slot, opened where the landing says: in the text at an inline
 * landing, in a paragraph of its own at a seam, and after the block at a
 * source landing (a paste in code).
 */
function insertPendingImageNode(
  editor: Editor,
  alt: string,
  token: string,
  at: Landing,
): number | null {
  const { state } = editor;
  const imageType = state.schema.nodes.image;
  const paragraphType = state.schema.nodes.paragraph;
  if (!imageType || !paragraphType) return null;

  const target = Math.max(0, Math.min(at.pos, state.doc.content.size));
  const image = imageType.create({
    src: PENDING_IMAGE_SRC,
    alt,
    title: null,
    [UPLOAD_TOKEN_ATTR]: token,
  });
  const transaction = state.tr;
  let imagePos: number;

  if (at.kind === "inline") {
    transaction.insert(target, image);
    imagePos = target;
  } else {
    const $target = state.doc.resolve(target);
    const seam =
      at.kind === "seam" ? target : $target.depth === 0 ? target : $target.after($target.depth);
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

/** The picture's slot, landed as a sweep-replace: the swept cells emptied and the picture standing in its own paragraph in the rectangle's top-left cell, in one transaction — so one undo restores the sweep and takes the picture with it. */
function insertPendingImageInSweep(editor: Editor, alt: string, token: string): number | null {
  const { state } = editor;
  const imageType = state.schema.nodes.image;
  const paragraphType = state.schema.nodes.paragraph;
  if (!imageType || !paragraphType) return null;
  const image = imageType.create({
    src: PENDING_IMAGE_SRC,
    alt,
    title: null,
    [UPLOAD_TOKEN_ATTR]: token,
  });
  const landed = sweepReplaceLanding(state, () => Fragment.from(paragraphType.create(null, image)));
  if (!landed) return null;
  // The landing already put the caret after the picture, as an insert does.
  editor.view.dispatch(landed.transaction.scrollIntoView());
  // The paragraph opens the landing; the picture is its first child.
  return landed.from + 1;
}

/** Write these attributes onto the slot at `pos`, over the ones it has now. */
function writeSlot(
  editor: Editor,
  pos: number,
  attrs: Record<string, unknown>,
  options: { history: boolean; closes?: string },
): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  // Attribute steps, because `setNodeMarkup` replaces a leaf and a selected slot would lose its grips.
  const transaction = editor.state.tr;
  for (const [name, value] of Object.entries(attrs)) transaction.setNodeAttribute(pos, name, value);
  if (!options.history) transaction.setMeta("addToHistory", false);
  if (options.closes) {
    transaction.setMeta(imageIngressPluginKey, {
      drop: options.closes,
    } satisfies ImageIngressMessage);
  }
  editor.view.dispatch(transaction);
}

/** Open one picture's record in this editor: its token, which is its intake id, and its shape. */
function openUpload(
  editor: Editor,
  input: { file: File; alt: string; landing: PendingImageUpload["landing"] },
): string {
  const id = crypto.randomUUID();
  const entry: PendingImageUpload = {
    kind: "upload",
    id,
    filename: input.file.name,
    alt: input.alt,
    frame: null,
    landing: input.landing,
  };
  sendIngressMessage(editor, { set: entry });

  void measureImageFile(input.file).then((frame) => {
    if (!frame) return;
    patchUpload(editor, id, (current) => ({ ...current, frame }));
  });

  return id;
}

/** Hand the bytes to the upload store, which sends them, holds the progress and any retry. */
function sendUpload(editor: Editor, host: ImageIngressHost, id: string, file: File): void {
  const storage = imageIngressStorage(editor);
  if (!storage) return;
  uploads.begin(id, storage.holder, async (signal, onProgress) => {
    const entry = uploadEntry(editor, id);
    const uploaded = await host.upload({ id, file, alt: entry?.alt ?? "", signal, onProgress });
    landUpload(editor, id, uploaded);
  });
}

/**
 * The bytes arrived: the picture's own node becomes the picture. Throws when it cannot, which the
 * store shows on the slot as a failure: a slot out of the text that comes back retries, and
 * resuming a finished upload lands at once.
 */
function landUpload(editor: Editor, id: string, uploaded: UploadedImage): void {
  const entry = editor.isDestroyed ? null : uploadEntry(editor, id);
  const at = entry && resolvePendingImage(editor.state, entry);
  if (!entry || !at) throw new Error(t`The upload was stopped.`);
  if (!editor.isEditable) throw new Error(t`This document is not taking changes right now.`);
  const picture = { src: uploaded.src, alt: uploaded.alt ?? entry.alt };

  if (entry.landing === "insert") {
    writeSlot(
      editor,
      at.from,
      { ...picture, [UPLOAD_TOKEN_ATTR]: null },
      { history: false, closes: id },
    );
    return;
  }

  // Two writes, and their order is the promise. The token leaves first and
  // outside history — an undo that brought it back would hand the writer a slot
  // whose upload is over — and that non-historical transaction also closes the
  // Yjs UndoManager's capture window (y-tiptap calls `stopCapturing` for one), so
  // the replacement below cannot merge with whatever the writer typed a moment
  // before their bytes arrived.
  writeSlot(editor, at.from, { [UPLOAD_TOKEN_ATTR]: null }, { history: false, closes: id });
  // The whole of the writer's edit, in one step they can take back: the same
  // node, the new picture, and nothing else touched. The position still holds
  // because an attribute write moves nothing.
  writeSlot(editor, at.from, picture, { history: true });
}
