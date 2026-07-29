/**
 * A picture from this machine: the slot it takes, and what happens to that slot
 * while its bytes travel.
 *
 * The order is the design (§5.6) and it is the whole fix: the node lands first,
 * the upload follows, and everything after is that node's business. Landing
 * writes one attribute onto the same node, so nothing is inserted at completion
 * and no line of prose moves.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

import { holdNode } from "../anchors";
import type { ImageIngressHost, UploadedImage } from "./image-ingress-ports";
import {
  type ImageIngressMessage,
  imageIngressPluginKey,
  imageIngressStorage,
  ingressState,
  nextIngressId,
  patchUpload,
  sendIngressMessage,
  uploadEntry,
} from "./image-ingress-runtime";
import { imageAltFromFilename, isImageFile } from "./image-workflow";
import { measureImageFile } from "./measure-image";
import {
  PENDING_IMAGE_SRC,
  type PendingImageUpload,
  pendingImageAt,
  resolvePendingImage,
} from "./pending-images";

/**
 * Ask the writer for an image file, and hand it to whoever asked.
 *
 * The input is created and clicked rather than rendered: a host that has to
 * keep a hidden `<input>` in its tree is a host that owns part of this
 * lifecycle.
 */
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

/**
 * Is there anywhere for a picture to go? Refusing out loud when there is no
 * project is the same law-5 rule as the greyed toolbar control — a picker that
 * leads nowhere is worse than a control that says why.
 */
function ingressHost(editor: Editor | null): ImageIngressHost | null {
  const storage = imageIngressStorage(editor);
  if (!editor || !storage || !editor.isEditable) return null;
  if (!storage.host) {
    storage.status.refuse(t`Images need a project before they can be uploaded.`);
    return null;
  }
  return storage.host;
}

/** A new picture, at the caret. */
export function openImagePicker(editor: Editor | null): void {
  if (!editor || !ingressHost(editor)) return;
  pickImageFile((file) => insertImageFile(editor, file));
}

/**
 * Another picture for a slot the writer already placed (§5.6's Replace verb, on
 * the object surface's ⋮).
 *
 * The node stays exactly where it is and keeps everything the writer wrote about
 * it — its alt text, and a figure's caption and label. The ordinary upload
 * lifecycle then runs over that slot: same entry, same progress, same failure,
 * and a landing that writes one attribute. So nothing is inserted, nothing is
 * removed, the manuscript does not move, and undo takes the replacement back in
 * one step.
 */
export function openImageReplacePicker(editor: Editor | null, pos: number): void {
  if (!editor || !ingressHost(editor)) return;
  pickImageFile((file) => replaceImageFile(editor, pos, file));
}

export function replaceImageFile(editor: Editor | null, pos: number, file: File): void {
  const storage = imageIngressStorage(editor);
  const host = ingressHost(editor);
  if (!editor || !storage || !host) return;
  if (!isImageFile(file)) {
    storage.status.refuse(
      t`${file.name} is not an image. Choose a PNG, JPEG, GIF, WEBP, AVIF, or SVG.`,
    );
    return;
  }
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  // The writer's own alt text outlives the picture it described only if they
  // wrote one; a slot that never had one takes the new file's name, as an insert
  // does.
  const existing = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  startUpload(editor, host, { file, alt: existing || imageAltFromFilename(file.name), at: pos });
}

/**
 * Put this picture in the document and start sending it.
 *
 * The node lands first and the upload follows, which is the whole point: the
 * writer's slot is theirs from the moment they asked for it, and everything
 * after this is that node's business.
 */
export function insertImageFile(editor: Editor | null, file: File, pos?: number): void {
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
  const at = insertPendingImageNode(editor, alt, pos);
  if (at === null) {
    storage.status.refuse(t`A picture cannot go there.`);
    return;
  }
  startUpload(editor, host, { file, alt, at });
}

/** Send a failed picture again, from the same slot with the same bytes. */
export function retryPendingImage(editor: Editor | null, pos: number): void {
  const storage = imageIngressStorage(editor);
  if (!editor || !storage?.host) return;
  const entry = pendingImageAt(ingressState(editor).pending, editor.state, pos);
  if (entry?.kind !== "upload" || entry.status.kind !== "failed") return;
  const controller = new AbortController();
  const retried: PendingImageUpload = {
    ...entry,
    status: { kind: "uploading", percent: null },
    abort: () => controller.abort(),
  };
  sendIngressMessage(editor, { set: retried });
  void runUpload(editor, storage.host, retried.id, controller.signal);
}

/** Take the picture back out. Whatever was in flight for it stops. */
export function removePendingImage(editor: Editor | null, pos: number): void {
  if (!editor || editor.isDestroyed) return;
  const entry = pendingImageAt(ingressState(editor).pending, editor.state, pos);
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

export function startUpload(
  editor: Editor,
  host: ImageIngressHost,
  input: { file: File; alt: string; at: number },
): void {
  const hold = holdNode(editor.state, input.at);
  // Only a document with no picture at `input.at` answers null, which the
  // insertion this follows has just ruled out.
  if (!hold) return;
  const controller = new AbortController();
  const id = nextIngressId("image-upload");
  const entry: PendingImageUpload = {
    kind: "upload",
    id,
    hold,
    filename: input.file.name,
    alt: input.alt,
    file: input.file,
    frame: null,
    status: { kind: "uploading", percent: null },
    abort: () => controller.abort(),
  };
  sendIngressMessage(editor, { set: entry });

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
  const storage = imageIngressStorage(editor);
  const entry = uploadEntry(editor, id);
  if (!editor || editor.isDestroyed || !storage || !entry) return;
  const at = resolvePendingImage(editor.state, entry);
  // The slot is gone, so there is nothing to land in. The asset stays in the
  // project, which is where the writer put it.
  if (!at) {
    sendIngressMessage(editor, { drop: id });
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
