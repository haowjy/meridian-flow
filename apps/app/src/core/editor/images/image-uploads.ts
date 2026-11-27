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
import { endUndoStep } from "../editor-history";
import { snapOutOfUnits } from "../landing/inline-snap";
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

function ingressHost(editor: Editor | null): ImageIngressHost | null {
  const storage = imageIngressStorage(editor);
  if (!editor || !storage || !editor.isEditable) return null;
  if (!storage.host) {
    storage.status.refuse(t`Couldn't upload`);
    return null;
  }
  return storage.host;
}

export type ImagePickerTarget =
  | { kind: "insert"; at: EditorAnchor }
  | { kind: "replace"; slot: NodeHold };

export function imageCaretTarget(editor: Editor | null): ImagePickerTarget | null {
  if (!editor || editor.isDestroyed) return null;
  // Select-all leaves a selection that starts at the document's edge, outside
  // every block; the nearest place a caret can stand is where the picture goes.
  const at = Selection.near(editor.state.selection.$from).from;
  return { kind: "insert", at: anchorRange(editor.state, { from: at, to: at }) };
}

export function imageReplaceTarget(editor: Editor | null, pos: number): ImagePickerTarget | null {
  if (!editor || editor.isDestroyed) return null;
  const slot = holdNode(editor.state, pos);
  return slot && { kind: "replace", slot };
}

export function openImagePicker(editor: Editor | null, target: ImagePickerTarget | null): void {
  if (!editor || !target || !ingressHost(editor)) return;
  pickImageFile((file) =>
    target.kind === "replace"
      ? replaceImageFile(editor, target.slot, file)
      : insertImageAtAnchor(editor, target.at, file),
  );
}

function insertImageAtAnchor(editor: Editor, anchor: EditorAnchor, file: File): void {
  const storage = imageIngressStorage(editor);
  if (!storage) return;
  const at = resolveAnchorIn(editor.state, anchor);
  if (!at || !acceptsInlineImage(editor.state.doc, at.from)) {
    storage.status.refuse(t`Can’t drop here`);
    return;
  }
  insertImageFile(editor, file, { kind: "inline", pos: at.from });
}

function replaceImageFile(editor: Editor | null, target: NodeHold, file: File): void {
  const storage = imageIngressStorage(editor);
  const host = ingressHost(editor);
  if (!editor || !storage || !host) return;
  if (!isImageFile(file)) {
    storage.status.refuse(t`Not an image`);
    return;
  }
  const at = resolveNodeHold(editor.state, target);
  const node = at && editor.state.doc.nodeAt(at.from);
  if (!at || !node || objectSurfaceKind(node) !== "image") return;
  const existing = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const id = openUpload(editor, {
    file,
    alt: existing || imageAltFromFilename(file.name),
    landing: "replace",
  });
  writeSlot(editor, at.from, { [UPLOAD_TOKEN_ATTR]: id }, { history: false });
  sendUpload(editor, host, id, file);
}

export function insertImageFile(editor: Editor | null, file: File, at: Landing): void {
  openImageFileUpload(editor, file, (target, alt, token) =>
    insertPendingImageNode(target, alt, token, at),
  );
}

export function pasteImageFile(editor: Editor | null, file: File): void {
  if (!editor || editor.isDestroyed) return;
  if (editor.state.selection instanceof CellSelection) {
    openImageFileUpload(editor, file, insertPendingImageInSweep);
    return;
  }
  const { from } = editor.state.selection;
  insertImageFile(editor, file, {
    kind: acceptsInlineImage(editor.state.doc, from) ? "inline" : "source",
    pos: from,
  });
}

function openImageFileUpload(
  editor: Editor | null,
  file: File,
  place: (editor: Editor, alt: string, token: string) => number | null,
): void {
  const storage = imageIngressStorage(editor);
  if (!editor || !storage || !editor.isEditable) return;
  if (!isImageFile(file)) {
    storage.status.refuse(t`Not an image`);
    return;
  }
  const host = ingressHost(editor);
  if (!host) return;
  const alt = imageAltFromFilename(file.name);
  const id = openUpload(editor, { file, alt, landing: "insert" });
  // A picture is its own undo step, apart from the typing before it. The upload's meta-only
  // message above does not close the capture window.
  endUndoStep(editor.state);
  const at = place(editor, alt, id);
  if (at === null) {
    sendIngressMessage(editor, { drop: id });
    storage.status.refuse(t`Can’t drop here`);
    return;
  }
  sendUpload(editor, host, id, file);
}

export function retryPendingImage(editor: Editor | null, pos: number): void {
  if (!editor || editor.isDestroyed) return;
  const entry = pendingImageAt(ingressState(editor).pending, editor.state, pos);
  if (entry?.kind === "upload") uploads.retry(entry.id);
}

export function removePendingImage(editor: Editor | null, pos: number): void {
  if (!editor || editor.isDestroyed) return;
  const entry = pendingImageAt(ingressState(editor).pending, editor.state, pos);
  if (entry?.kind !== "upload") return;
  editor.view.dispatch(editor.state.tr.delete(pos, pos + 1));
}

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

  const clamped = Math.max(0, Math.min(at.pos, state.doc.content.size));
  const target = at.kind === "inline" ? snapOutOfUnits(state.doc, clamped) : clamped;
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

  transaction.setSelection(TextSelection.near(transaction.doc.resolve(imagePos + 1)));
  transaction.scrollIntoView();
  editor.view.dispatch(transaction);
  return imagePos;
}

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
  editor.view.dispatch(landed.transaction.scrollIntoView());
  return landed.from + 1;
}

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

function sendUpload(editor: Editor, host: ImageIngressHost, id: string, file: File): void {
  const storage = imageIngressStorage(editor);
  if (!storage) return;
  uploads.begin(id, storage.holder, async (signal, onProgress) => {
    const entry = uploadEntry(editor, id);
    const uploaded = await host.upload({ id, file, alt: entry?.alt ?? "", signal, onProgress });
    landUpload(editor, id, uploaded);
  });
}

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
  // open Undo step (`editor-history.ts`), so the replacement below cannot merge with whatever the writer typed a moment
  // before their bytes arrived.
  writeSlot(editor, at.from, { [UPLOAD_TOKEN_ATTR]: null }, { history: false, closes: id });
  writeSlot(editor, at.from, picture, { history: true });
}
