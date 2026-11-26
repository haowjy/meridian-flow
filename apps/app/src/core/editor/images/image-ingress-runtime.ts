import type { Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";

import { type UploadWatch, uploads } from "@/core/uploads/upload-store";

import { type AnchorRange, carryAnchor } from "../anchors";
import type { ImageIngressHost } from "./image-ingress-ports";
import type { ImageIngressStore } from "./image-ingress-store";
import type { PastedImageImport } from "./image-workflow";
import {
  NO_PENDING_IMAGES,
  type PendingImage,
  type PendingImageFrame,
  type PendingImageState,
  type PendingImageUpload,
} from "./pending-images";

export const IMAGE_INGRESS_NAME = "meridianImageIngress";

export type ImageIngressStorage = {
  status: ImageIngressStore;
  host: ImageIngressHost | null;
  holder: string;
  watch: UploadWatch | null;
};

declare module "@tiptap/core" {
  interface Storage {
    meridianImageIngress: ImageIngressStorage;
  }
}

export type LandingImports = { imports: readonly PastedImageImport[]; range: AnchorRange };

export type ImageIngressPluginState = {
  pending: PendingImageState;
  landing: LandingImports | null;
};

export type ImageIngressMessage =
  | { set: PendingImage }
  | { drop: string }
  | { landing: LandingImports | null }
  | { redraw: true };

export const imageIngressPluginKey = new PluginKey<ImageIngressPluginState>(IMAGE_INGRESS_NAME);

export const EMPTY_INGRESS_STATE: ImageIngressPluginState = {
  pending: NO_PENDING_IMAGES,
  landing: null,
};

export type AnnouncedUpload = { token: string; frame: PendingImageFrame | null };

export function imageIngressStorage(editor: Editor | null | undefined): ImageIngressStorage | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[IMAGE_INGRESS_NAME] ?? null;
}

export function ingressState(editor: Editor | null | undefined): ImageIngressPluginState {
  if (!editor || editor.isDestroyed) return EMPTY_INGRESS_STATE;
  return imageIngressPluginKey.getState(editor.state) ?? EMPTY_INGRESS_STATE;
}

export function imageIngressStatus(editor: Editor | null): ImageIngressStore | null {
  return imageIngressStorage(editor)?.status ?? null;
}

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

export function uploadsOwnedHere(editor: Editor | null): readonly AnnouncedUpload[] {
  const storage = imageIngressStorage(editor);
  if (!editor || !storage) return [];
  return uploads
    .sending(storage.holder)
    .map((token) => ({ token, frame: uploadEntry(editor, token)?.frame ?? null }));
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

export function sendIngressMessage(editor: Editor, message: ImageIngressMessage): void {
  if (editor.isDestroyed) return;
  const transaction = editor.state.tr.setMeta(imageIngressPluginKey, message);
  transaction.setMeta("addToHistory", false);
  editor.view.dispatch(transaction);
}

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
  if ("redraw" in message) return current;
  if ("landing" in message) return { ...current, landing: message.landing };
  const pending = new Map(current.pending);
  if ("drop" in message) pending.delete(message.drop);
  else pending.set(message.set.id, message.set);
  return { ...current, pending };
}
