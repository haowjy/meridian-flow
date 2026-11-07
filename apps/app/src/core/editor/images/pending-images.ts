/** Tracks pending image insertions and their anchored upload state. */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { type UploadFrame, type UploadState, uploads } from "@/core/uploads/upload-store";

import { type AnchorRange, carryAnchor, type EditorAnchor, resolveAnchorIn } from "../anchors";
import { pastedImageLinkRange } from "./image-workflow";

/** The document attribute naming a slot some browser is filling right now. */
export const UPLOAD_TOKEN_ATTR = "uploadToken";

/** The attribute as the schema declares it, shared by `image` and `figure` (Replace aims an upload at a figure too). */
export const UPLOAD_TOKEN_ATTRIBUTE = {
  default: null,
  rendered: false,
  parseHTML: () => null,
};

/** The upload filling this node's slot, or null for an ordinary picture. */
export function uploadTokenOf(node: PMNode): string | null {
  const token = node.attrs[UPLOAD_TOKEN_ATTR];
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** The picture's own size, measured locally so its slot is the right shape. */
export type PendingImageFrame = UploadFrame;

/**
 * A picture whose bytes are on their way to the project: what only this editor knows of it. How
 * the upload stands, its abort and its file are the upload store's, under the same id.
 */
export type PendingImageUpload = {
  kind: "upload";
  /** The upload's intake id, and the `uploadToken` written on its slot. */
  id: string;
  filename: string;
  /** The pending node's `alt`, unchanged when the upload lands. */
  alt: string;
  /** Null until the browser has decoded enough to say, or refuses to. */
  frame: PendingImageFrame | null;
  /** How this upload got its slot, and therefore what the writer undoes when the bytes land (`image-uploads.ts`). */
  landing: "insert" | "replace";
};

/** A picture the clipboard only pointed at, being fetched into the project. */
export type PendingImageImport = {
  kind: "import";
  id: string;
  /** The link's range. */
  hold: EditorAnchor;
  url: string;
  filename: string;
  abort: () => void;
};

export type PendingImage = PendingImageUpload | PendingImageImport;

/** Every picture this editor is waiting on. Empty is the ordinary state. */
export type PendingImageState = ReadonlyMap<string, PendingImage>;

export const NO_PENDING_IMAGES: PendingImageState = new Map();

/** A pending node's source: the one `src` that names nothing. */
export const PENDING_IMAGE_SRC = "";

/** Carry what a transaction can move across its own mapping. */
export function carryPendingImages(
  pending: PendingImageState,
  mapping: Mappable,
): PendingImageState {
  if (pending.size === 0) return pending;
  const next = new Map<string, PendingImage>();
  for (const [id, entry] of pending) {
    if (entry.kind === "upload") {
      next.set(id, entry);
      continue;
    }
    const hold = carryAnchor(entry.hold, mapping);
    if (hold) next.set(id, { ...entry, hold });
  }
  return next;
}

/** The slot this token is written on, or null once the document holds none. */
export function slotForUploadToken(doc: PMNode, token: string): AnchorRange | null {
  let found: AnchorRange | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (uploadTokenOf(node) === token) found = { from: pos, to: pos + node.nodeSize };
    return found === null;
  });
  return found;
}

/**
 * Where this pending picture is now, or null once the writer's document no
 * longer holds it.
 */
export function resolvePendingImage(state: EditorState, entry: PendingImage): AnchorRange | null {
  if (entry.kind === "upload") return slotForUploadToken(state.doc, entry.id);
  const at = resolveAnchorIn(state, entry.hold);
  return at && pastedImageLinkRange(state.doc, at, entry.url);
}

/** The pending picture standing at `pos`, or null. */
export function pendingImageAt(
  pending: PendingImageState,
  state: EditorState,
  pos: number,
): PendingImage | null {
  const node = state.doc.nodeAt(pos);
  const token = node ? uploadTokenOf(node) : null;
  const upload = token === null ? undefined : pending.get(token);
  if (upload?.kind === "upload") return upload;
  for (const entry of pending.values()) {
    if (entry.kind === "import" && resolvePendingImage(state, entry)?.from === pos) return entry;
  }
  return null;
}

/**
 * Entries with nothing left to wait for: an import whose link is gone, and an upload the store
 * has let go of. An upload whose slot left the text stays: the store decides when the writer took
 * it back, and an undo inside that time brings the slot back still sending.
 */
export function finishedPendingImages(
  pending: PendingImageState,
  state: EditorState,
): PendingImage[] {
  return [...pending.values()].filter((entry) =>
    entry.kind === "upload" ? uploads.read(entry.id) === null : !resolvePendingImage(state, entry),
  );
}

/** Every token this document currently carries, in one pass. */
export function uploadTokensIn(doc: PMNode): ReadonlySet<string> {
  const tokens = new Set<string>();
  doc.descendants((node) => {
    const token = uploadTokenOf(node);
    if (token !== null) tokens.add(token);
    return true;
  });
  return tokens;
}

/** Who is filling a slot, as the node view is told it. */
export type PendingUploadOwner =
  | { owner: "mine"; entry: PendingImageUpload; status: UploadState }
  | { owner: "elsewhere"; frame: PendingImageFrame | null };

/**
 * What the manuscript shows for every picture in flight, mine and theirs. `slots` says whether
 * the text may hold a slot at all, so a document with none is never walked.
 */
export function pendingImageDecorations(
  pending: PendingImageState,
  state: EditorState,
  slots: boolean,
): DecorationSet | null {
  const decorations: Decoration[] = [];

  if (slots) {
    state.doc.descendants((node, pos) => {
      const token = uploadTokenOf(node);
      if (token === null) return true;
      const mine = pending.get(token);
      const status = mine?.kind === "upload" ? uploads.read(token) : null;
      const elsewhere = status ? undefined : uploads.peerSending(token);
      const owner: PendingUploadOwner | null =
        mine?.kind === "upload" && status
          ? { owner: "mine", entry: mine, status }
          : elsewhere !== undefined
            ? { owner: "elsewhere", frame: elsewhere }
            : null;
      if (owner) decorations.push(uploadDecoration(pos, pos + node.nodeSize, owner));
      return true;
    });
  }

  for (const entry of pending.values()) {
    if (entry.kind !== "import") continue;
    const at = resolvePendingImage(state, entry);
    if (at) decorations.push(Decoration.inline(at.from, at.to, { class: IMPORTING_LINK_CLASS }));
  }

  return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null;
}

function uploadDecoration(from: number, to: number, pending: PendingUploadOwner): Decoration {
  const status = pending.owner === "mine" ? pending.status : null;
  const percent = status?.kind === "uploading" ? status.percent : null;
  const frame = pending.owner === "mine" ? pending.entry.frame : pending.frame;
  return Decoration.node(
    from,
    to,
    {
      "data-pending-image": status ? status.kind : "elsewhere",
      "data-upload-percent": percent === null ? "" : String(percent),
      "data-upload-frame": frame ? `${frame.width}x${frame.height}` : "",
    },
    { pendingUpload: pending },
  );
}

/** Marks a link whose picture is being fetched. The link stays a link. */
export const IMPORTING_LINK_CLASS = "meridian-image-importing";

/** Who is filling the slot a node view is rendering, read off the decorations ProseMirror handed it. */
export function pendingUploadFromDecorations(
  decorations: readonly { spec?: unknown }[],
): PendingUploadOwner | null {
  for (const decoration of decorations) {
    const pending = (decoration.spec as { pendingUpload?: PendingUploadOwner } | undefined)
      ?.pendingUpload;
    if (pending) return pending;
  }
  return null;
}

/** What a node view has to repaint for. */
export function pendingImageSignature(decorations: readonly { spec?: unknown }[]): string {
  const pending = pendingUploadFromDecorations(decorations);
  if (!pending) return "";
  if (pending.owner === "elsewhere") return `elsewhere|${frameSignature(pending.frame)}`;
  const { entry, status } = pending;
  const progress = status.kind === "uploading" ? (status.percent ?? "") : "";
  return `${entry.id}|${status.kind}|${progress}|${frameSignature(entry.frame)}`;
}

function frameSignature(frame: PendingImageFrame | null): string {
  return frame ? `${frame.width}x${frame.height}` : "";
}
