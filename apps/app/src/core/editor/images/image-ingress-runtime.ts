/**
 * The editor's own record of the pictures it is waiting on.
 *
 * One plugin state, one storage slot, one way to write to them. Every door
 * (picker, drop, paste, import) reads and writes the same record through this
 * module, so there is one answer to "what is in flight here" and no second
 * registry can appear beside it.
 *
 * Messages carry no steps, so a percent is not an edit: it never reaches Yjs,
 * the wire, or anyone's undo history.
 */

import type { Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";

import { type AnchorRange, carryAnchor } from "../anchors";
import type { ImageIngressHost } from "./image-ingress-ports";
import type { ImageIngressStore } from "./image-ingress-store";
import type { MutableAssetPathResolver, PastedImageImport } from "./image-workflow";
import {
  NO_PENDING_IMAGES,
  NO_UPLOAD_OWNERS,
  type PendingImage,
  type PendingImageState,
  type PendingImageUpload,
  type UploadOwnersElsewhere,
} from "./pending-images";

export const IMAGE_INGRESS_NAME = "meridianImageIngress";

export type ImageIngressStorage = {
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
export type LandingImports = { imports: readonly PastedImageImport[]; range: AnchorRange };

export type ImageIngressPluginState = {
  pending: PendingImageState;
  landing: LandingImports | null;
  /**
   * Upload tokens another client is filling right now
   * (`image-upload-presence.ts` puts them here).
   *
   * Beside `pending` rather than merged into it: these have no bytes, no
   * percent, and nothing this browser could retry — only the fact that an
   * owner is live, which is what stops a peer calling an active upload
   * abandoned.
   */
  elsewhere: UploadOwnersElsewhere;
};

export type ImageIngressMessage =
  | { set: PendingImage }
  | { drop: string }
  | { landing: LandingImports | null }
  | { elsewhere: UploadOwnersElsewhere };

export const imageIngressPluginKey = new PluginKey<ImageIngressPluginState>(IMAGE_INGRESS_NAME);

export const EMPTY_INGRESS_STATE: ImageIngressPluginState = {
  pending: NO_PENDING_IMAGES,
  landing: null,
  elsewhere: NO_UPLOAD_OWNERS,
};

let ingressSequence = 0;
/**
 * This tab's share of every id, so no two clients can mint the same one.
 *
 * An upload's id is written into the shared document as its slot's
 * `uploadToken` (`pending-images.ts`), so a counter alone would have two writers
 * claiming each other's slots after both opened the document.
 */
const ingressOrigin = Math.random().toString(36).slice(2, 10);

/** A new id for one arrival. Ids never repeat, here or on any other client. */
export function nextIngressId(prefix: string): string {
  ingressSequence += 1;
  return `${prefix}:${ingressOrigin}:${ingressSequence}`;
}

export function imageIngressStorage(editor: Editor | null | undefined): ImageIngressStorage | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[IMAGE_INGRESS_NAME] ?? null;
}

export function ingressState(editor: Editor | null | undefined): ImageIngressPluginState {
  if (!editor || editor.isDestroyed) return EMPTY_INGRESS_STATE;
  return imageIngressPluginKey.getState(editor.state) ?? EMPTY_INGRESS_STATE;
}

/** This editor's asset index, for a surface that translates `asset:` refs. */
export function editorAssetIndex(editor: Editor | null): MutableAssetPathResolver | null {
  return imageIngressStorage(editor)?.assetIndex ?? null;
}

/** Drag state and refusals for this editor's ingress, for the app to render. */
export function imageIngressStatus(editor: Editor | null): ImageIngressStore | null {
  return imageIngressStorage(editor)?.status ?? null;
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
  const storage = imageIngressStorage(editor);
  if (!storage) return () => {};
  storage.host = host;
  return () => {
    if (storage.host === host) storage.host = null;
  };
}

/** Every picture this editor is waiting on, for tests and surfaces that ask. */
export function pendingImages(editor: Editor | null): readonly PendingImage[] {
  return Array.from(ingressState(editor).pending.values());
}

/** The upload tokens this client owns, which is what it announces to peers. */
export function uploadTokensOwnedHere(editor: Editor | null): readonly string[] {
  const owned: string[] = [];
  for (const entry of ingressState(editor).pending.values()) {
    if (entry.kind === "upload") owned.push(entry.id);
  }
  return owned;
}

export function uploadEntry(editor: Editor, id: string): PendingImageUpload | null {
  const entry = ingressState(editor).pending.get(id);
  return entry?.kind === "upload" ? entry : null;
}

export function patchUpload(
  editor: Editor,
  id: string,
  next: (current: PendingImageUpload) => PendingImageUpload,
): void {
  const current = uploadEntry(editor, id);
  if (!current) return;
  const updated = next(current);
  if (updated !== current) sendIngressMessage(editor, { set: updated });
}

/**
 * Tell the document about a pending picture. Meta only: no step reaches Yjs, so
 * a percent is not an edit and never enters anyone's undo history.
 */

export function sendIngressMessage(editor: Editor, message: ImageIngressMessage): void {
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
export function carryLanding(
  landing: LandingImports | null,
  mapping: Mappable,
): LandingImports | null {
  if (!landing) return null;
  const carried = carryAnchor({ ...landing.range, relative: null }, mapping);
  return carried
    ? { imports: landing.imports, range: { from: carried.from, to: carried.to } }
    : null;
}

export function applyIngressMessage(
  current: ImageIngressPluginState,
  message: ImageIngressMessage,
): ImageIngressPluginState {
  if ("landing" in message) return { ...current, landing: message.landing };
  if ("elsewhere" in message) return { ...current, elsewhere: message.elsewhere };
  const pending = new Map(current.pending);
  if ("drop" in message) pending.delete(message.drop);
  else pending.set(message.set.id, message.set);
  return { ...current, pending };
}
