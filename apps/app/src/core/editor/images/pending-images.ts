/** Tracks pending image insertions and their anchored upload state. */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

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
export type PendingImageFrame = { width: number; height: number };

export type PendingUploadStatus =
  | { kind: "uploading"; percent: number | null }
  | { kind: "failed"; message: string };

/** A picture whose bytes are on their way to the project. */
export type PendingImageUpload = {
  kind: "upload";
  /** The upload's identity, and the `uploadToken` written on its slot. */
  id: string;
  filename: string;
  /** The pending node's `alt`, unchanged when the upload lands. */
  alt: string;
  file: File;
  /** Null until the browser has decoded enough to say, or refuses to. */
  frame: PendingImageFrame | null;
  /** How this upload got its slot, and therefore what the writer undoes when the bytes land (`image-uploads.ts`). */
  landing: "insert" | "replace";
  status: PendingUploadStatus;
  abort: () => void;
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

/**
 * What another client is filling right now, as awareness reports it: its token,
 * and the shape that slot should hold until the bytes land.
 */
export type UploadOwnersElsewhere = ReadonlyMap<string, PendingImageFrame | null>;

export const NO_UPLOAD_OWNERS: UploadOwnersElsewhere = new Map();

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

/** Entries whose place in the document is gone: their upload has no landing. */
export function orphanedPendingImages(
  pending: PendingImageState,
  state: EditorState,
): PendingImage[] {
  const orphaned: PendingImage[] = [];
  const held = uploadTokensIn(state.doc);
  for (const entry of pending.values()) {
    if (entry.kind === "upload") {
      if (!held.has(entry.id)) orphaned.push(entry);
      continue;
    }
    if (!resolvePendingImage(state, entry)) orphaned.push(entry);
  }
  return orphaned;
}

/** Every token this document currently carries, in one pass. */
function uploadTokensIn(doc: PMNode): ReadonlySet<string> {
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
  | { owner: "mine"; entry: PendingImageUpload }
  | { owner: "elsewhere"; frame: PendingImageFrame | null };

/** What the manuscript shows for every picture in flight, mine and theirs. */
export function pendingImageDecorations(
  pending: PendingImageState,
  elsewhere: UploadOwnersElsewhere,
  state: EditorState,
): DecorationSet | null {
  const decorations: Decoration[] = [];

  if (pending.size > 0 || elsewhere.size > 0) {
    state.doc.descendants((node, pos) => {
      const token = uploadTokenOf(node);
      if (token === null) return true;
      const mine = pending.get(token);
      const owner: PendingUploadOwner | null =
        mine?.kind === "upload"
          ? { owner: "mine", entry: mine }
          : elsewhere.has(token)
            ? { owner: "elsewhere", frame: elsewhere.get(token) ?? null }
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
  const status = pending.owner === "mine" ? pending.entry.status : null;
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
  const { entry } = pending;
  const progress = entry.status.kind === "uploading" ? (entry.status.percent ?? "") : "";
  return `${entry.id}|${entry.status.kind}|${progress}|${frameSignature(entry.frame)}`;
}

function frameSignature(frame: PendingImageFrame | null): string {
  return frame ? `${frame.width}x${frame.height}` : "";
}
