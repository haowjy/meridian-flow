/**
 * A picture from this machine: the slot it takes, and what happens to that slot
 * while its bytes travel.
 *
 * The order is the design (§5.6) and it is the whole fix: the node lands first,
 * the upload follows, and everything after is that node's business. Landing
 * writes one attribute onto the same node, so nothing is inserted at completion
 * and no line of prose moves.
 *
 * One ordering rule is not cosmetic. An upload's entry — and therefore the owner
 * signal peers read (`image-upload-presence.ts`) — is opened BEFORE the token's
 * slot reaches the document. Awareness leaves on the announcement's own
 * dispatch and the document update leaves on the insert's, so no collaborator
 * can see a slot in flight before it knows someone is filling it.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import {
  anchorRange,
  type EditorAnchor,
  holdNode,
  type NodeHold,
  resolveAnchorIn,
  resolveNodeHold,
} from "../anchors";
import { objectSurfaceKind } from "../objects";
import { sweepReplaceLanding } from "../table-sweep-paste";
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
import { acceptsInlineImage, imageAltFromFilename, isImageFile } from "./image-workflow";
import { measureImageFile } from "./measure-image";
import {
  PENDING_IMAGE_SRC,
  type PendingImageUpload,
  pendingImageAt,
  resolvePendingImage,
  UPLOAD_TOKEN_ATTR,
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

/**
 * Where a picture the writer is about to choose goes.
 *
 * **A target is held, never a number.** The operating system's chooser stays
 * open for as long as the writer takes, and every raw position in the document
 * means something else after one peer write or one AI write — the same hazard
 * `anchors.ts` exists for, at its worst. So the caller says what it is aiming at
 * BEFORE the chooser opens, in a shape that outlives it, and the file that comes
 * back is resolved against the document as it now stands. A picker holding
 * nothing would read the selection at file-return time, which is how a picture
 * asked for from a table cell once landed past the whole table.
 *
 * The two kinds are the two things a picture can be aimed at, and each takes the
 * hold that fits it: an existing picture is a NODE, and it is that node the
 * writer pointed at (a hold ends at a Yjs move, which is the honest answer for a
 * gesture); a new picture is a PLACE in the prose, which has no node yet and
 * survives as an anchor.
 */
export type ImagePickerTarget =
  /** A new picture at a place in the prose. */
  | { kind: "insert"; at: EditorAnchor }
  /** Another picture for a slot the writer already placed. */
  | { kind: "replace"; slot: NodeHold };

/** A new picture where the caret is now, pinned before the chooser opens. */
export function imageCaretTarget(editor: Editor | null): ImagePickerTarget | null {
  if (!editor || editor.isDestroyed) return null;
  const at = editor.state.selection.from;
  return { kind: "insert", at: anchorRange(editor.state, { from: at, to: at }) };
}

/**
 * The picture at `pos`, for §5.6's Replace verb (on the object surface's ⋮), or
 * null when nothing starts there.
 */
export function imageReplaceTarget(editor: Editor | null, pos: number): ImagePickerTarget | null {
  if (!editor || editor.isDestroyed) return null;
  const slot = holdNode(editor.state, pos);
  return slot && { kind: "replace", slot };
}

/**
 * Ask the writer for a picture, and put it where the target says.
 *
 * One door for both kinds, because the part that is hard is the part they share:
 * the wait. What differs afterwards is only what a resolved target means — an
 * insert makes a slot, a replace reuses one — and both refuse out loud rather
 * than falling back to wherever the caret has drifted to.
 */
export function openImagePicker(editor: Editor | null, target: ImagePickerTarget | null): void {
  if (!editor || !target || !ingressHost(editor)) return;
  pickImageFile((file) =>
    target.kind === "replace"
      ? replaceImageFile(editor, target.slot, file)
      : insertImageAtAnchor(editor, target.at, file),
  );
}

/**
 * A new picture at the place the writer asked from, however far the document
 * has moved since.
 *
 * The anchor answers where that place is now, and the schema answers whether it
 * is still a place a picture may stand — a peer can have turned the paragraph
 * into something that holds no inline content, or taken it away entirely. Both
 * questions are asked before an entry is opened, so a refusal costs no upload
 * and leaves the project no asset it has no use for.
 *
 * Nothing here searches for somewhere else to put it. The writer pointed at one
 * place; a picture that appeared anywhere but there — after the table they were
 * standing in, say — is a worse answer than a picture that says it cannot go.
 */
function insertImageAtAnchor(editor: Editor, anchor: EditorAnchor, file: File): void {
  const storage = imageIngressStorage(editor);
  if (!storage) return;
  const at = resolveAnchorIn(editor.state, anchor);
  if (!at || !acceptsInlineImage(editor.state.doc, at.from)) {
    storage.status.refuse(t`There is nowhere left to put that picture.`);
    return;
  }
  insertImageFile(editor, file, at.from);
}

/**
 * Another picture for a slot the writer already placed (§5.6's Replace verb).
 *
 * The node stays exactly where it is and keeps everything the writer wrote about
 * it — its alt text, and a figure's caption and label. The ordinary upload
 * lifecycle then runs over that slot: same entry, same progress, same failure.
 * So nothing is inserted, nothing is removed, the manuscript does not move, and
 * one undo puts the old picture back (`landUpload`).
 */
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
  const upload = beginUpload(editor, {
    file,
    alt: existing || imageAltFromFilename(file.name),
    landing: "replace",
  });
  // Bookkeeping rather than an edit, so it stays out of the writer's undo stack:
  // what they will undo is the picture, and that is the landing's business.
  writeSlot(editor, at.from, { [UPLOAD_TOKEN_ATTR]: upload.id }, { history: false });
  void runUpload(editor, host, upload.id, upload.signal);
}

/**
 * Put this picture in the document and start sending it.
 *
 * The node lands first and the upload follows, which is the whole point: the
 * writer's slot is theirs from the moment they asked for it, and everything
 * after this is that node's business.
 */
export function insertImageFile(editor: Editor | null, file: File, pos?: number): void {
  openImageFileUpload(editor, file, (target, alt, token) =>
    insertPendingImageNode(target, alt, token, pos),
  );
}

/**
 * An image file arriving from the clipboard — the paste door's one decision.
 *
 * A paste over a swept rectangle of cells means what every paste over a sweep
 * means (`../table-sweep-paste.ts`): the sweep is replaced, and the picture —
 * paragraph-hosted, the shape a cell block is — lands in the top-left cell.
 * Any other selection is the picture at the caret, exactly as an insert.
 */
export function pasteImageFile(editor: Editor | null, file: File): void {
  if (!editor || editor.isDestroyed) return;
  if (editor.state.selection instanceof CellSelection) {
    openImageFileUpload(editor, file, insertPendingImageInSweep);
    return;
  }
  insertImageFile(editor, file, editor.state.selection.from);
}

/**
 * One lifecycle for a picture file with somewhere to go: validate the file,
 * open the upload, let `place` land the slot, and start the bytes. `place`
 * answers where the slot stands — null is a refusal, and it costs no upload
 * and leaves the project no orphaned asset.
 */
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
  const upload = beginUpload(editor, { file, alt, landing: "insert" });
  const at = place(editor, alt, upload.id);
  if (at === null) {
    cancelUpload(editor, upload);
    storage.status.refuse(t`A picture cannot go there.`);
    return;
  }
  void runUpload(editor, host, upload.id, upload.signal);
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
 *
 * The slot carries its upload's token from the first moment, in the same
 * transaction, so the insert and its identity are one undoable step.
 */
function insertPendingImageNode(
  editor: Editor,
  alt: string,
  token: string,
  pos?: number,
): number | null {
  const { state } = editor;
  const imageType = state.schema.nodes.image;
  const paragraphType = state.schema.nodes.paragraph;
  if (!imageType || !paragraphType) return null;

  const target = Math.max(0, Math.min(pos ?? state.selection.from, state.doc.content.size));
  const image = imageType.create({
    src: PENDING_IMAGE_SRC,
    alt,
    title: null,
    [UPLOAD_TOKEN_ATTR]: token,
  });
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

/**
 * The picture's slot, landed as a sweep-replace: the swept cells emptied and
 * the picture standing in its own paragraph in the rectangle's top-left cell,
 * in one transaction — so one undo restores the sweep and takes the picture
 * with it. The transaction's shape is the sweep module's, not invented here;
 * this only says what the landing content is.
 */
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

/**
 * Write these attributes onto the slot at `pos`, over the ones it has now.
 *
 * Every write this file makes to an existing slot is one of these, and the two
 * facts that differ between them are its arguments: whether the writer will undo
 * it, and whether it also closes the upload's entry. Reading the node back here
 * rather than taking it from the caller is what keeps the merge honest — a
 * figure's caption, a peer's alt-text edit, whatever the slot gained since.
 */
function writeSlot(
  editor: Editor,
  pos: number,
  attrs: Record<string, unknown>,
  options: { history: boolean; closes?: string },
): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const transaction = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
  if (!options.history) transaction.setMeta("addToHistory", false);
  if (options.closes) {
    transaction.setMeta(imageIngressPluginKey, {
      drop: options.closes,
    } satisfies ImageIngressMessage);
  }
  editor.view.dispatch(transaction);
}

type OpenUpload = { id: string; signal: AbortSignal };

/**
 * Open one upload's lifecycle: its token, its entry, and the owner signal every
 * peer reads through it.
 *
 * Deliberately before the token's slot exists in the document. The frame is
 * measured from here too, so the slot is the picture's real shape before a
 * single byte has arrived.
 */
function beginUpload(
  editor: Editor,
  input: { file: File; alt: string; landing: PendingImageUpload["landing"] },
): OpenUpload {
  const controller = new AbortController();
  const id = nextIngressId("image-upload");
  const entry: PendingImageUpload = {
    kind: "upload",
    id,
    filename: input.file.name,
    alt: input.alt,
    file: input.file,
    frame: null,
    landing: input.landing,
    status: { kind: "uploading", percent: null },
    abort: () => controller.abort(),
  };
  sendIngressMessage(editor, { set: entry });

  void measureImageFile(input.file).then((frame) => {
    if (!frame) return;
    patchUpload(editor, id, (current) => ({ ...current, frame }));
  });

  return { id, signal: controller.signal };
}

/** The slot never opened, so neither did the upload. */
function cancelUpload(editor: Editor, upload: OpenUpload): void {
  uploadEntry(editor, upload.id)?.abort();
  sendIngressMessage(editor, { drop: upload.id });
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
 * The slot never moves and nothing is inserted or removed, which is why the
 * manuscript does not move — and the fence is re-read here because an upload
 * outlives the connection that started it.
 *
 * **What the writer undoes depends on how the slot was opened**, which is why the
 * entry carries it. An INSERT put the node there in a historical transaction, so
 * its bytes arriving is bookkeeping: undo takes the picture away rather than
 * stepping back through its own arrival and leaving an empty frame. A REPLACE was
 * aimed at a picture the writer already had, so the arrival IS the edit — this
 * picture became that picture — and it lands as one history event whose undo puts
 * the old one back.
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
