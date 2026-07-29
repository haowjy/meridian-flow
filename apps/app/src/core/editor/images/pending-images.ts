/**
 * What the document knows about a picture that has not arrived yet.
 *
 * The design's rule (§5.6): while an upload is in flight the image occupies its
 * FINAL slot as a quiet placeholder, so the manuscript never reflows when the
 * bytes land, and the placeholder is a normal node the writer can move or
 * delete — deleting it cancels the upload. So the slot is a real `image` node
 * from the first moment, and this module holds the part of a pending picture
 * that must not be in the shared document:
 *
 * - **Which slot belongs to which upload**, as an `EditorAnchor` (law 9: a
 *   peer's write replaces the whole document, so a number would point at
 *   nothing). Position is half the answer, so every read checks the node it
 *   lands on is still the pending picture it took hold of.
 * - **How far along it is**, which changes many times a second. An attribute
 *   would put every percent on the wire and in every peer's undo history.
 * - **The bytes and the abort**, which are this browser's business alone.
 *
 * The pending node's `src` is `""` — the schema's own default, the only source
 * that names nothing. That is the wire-safety decision: an in-flight picture
 * serializes as `![alt]()` and parses back to an empty `src`, so a document
 * saved or synced mid-upload round-trips honestly. The alternative — minting an
 * `asset:` ref before the asset exists — throws in the codec's
 * `pathForAsset` and takes the whole document's save with it.
 */

import type { EditorState } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  type AnchorRange,
  carryAnchor,
  type EditorAnchor,
  type NodeHold,
  resolveAnchorIn,
  resolveNodeHold,
} from "../anchors";
import { pastedImageLinkRange } from "./image-workflow";

/** The picture's own size, measured locally so its slot is the right shape. */
export type PendingImageFrame = { width: number; height: number };

export type PendingUploadStatus =
  | { kind: "uploading"; percent: number | null }
  | { kind: "failed"; message: string };

/** A picture whose bytes are on their way to the project. */
export type PendingImageUpload = {
  kind: "upload";
  id: string;
  /**
   * The `image` node standing in the picture's final slot, held the way every
   * long-lived surface in this editor holds its target: the anchor for where,
   * the Yjs element for which (`anchors.ts`).
   */
  hold: NodeHold;
  filename: string;
  /** The pending node's `alt`, unchanged when the upload lands. */
  alt: string;
  file: File;
  /** Null until the browser has decoded enough to say, or refuses to. */
  frame: PendingImageFrame | null;
  status: PendingUploadStatus;
  abort: () => void;
};

/**
 * A picture the clipboard only pointed at, being fetched into the project.
 *
 * Its placeholder is the link the paste left in place of the picture
 * (`image-workflow.ts`), which is also the honest end state when the fetch is
 * refused — so nothing has to be undone.
 */
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

/**
 * Carry every hold across one transaction's mapping.
 *
 * Dropping an entry here is only ever the mapping's verdict on an editor with
 * no shared document; identity answers on read, where the Yjs binding has
 * finished describing the document this transaction produced.
 */
export function carryPendingImages(
  pending: PendingImageState,
  mapping: Mappable,
): PendingImageState {
  if (pending.size === 0) return pending;
  const next = new Map<string, PendingImage>();
  for (const [id, entry] of pending) {
    // Per kind, because the two hold different things: an upload holds the
    // picture (identity and all), an import holds a range of text.
    if (entry.kind === "upload") {
      const hold = carryAnchor(entry.hold, mapping);
      if (hold) next.set(id, { ...entry, hold });
      continue;
    }
    const hold = carryAnchor(entry.hold, mapping);
    if (hold) next.set(id, { ...entry, hold });
  }
  return next;
}

/**
 * Where this pending picture is now, or null once the writer's document no
 * longer holds it.
 *
 * A picture is a node, so the hold answers both halves itself: coordinates
 * outlive what was at them, and a deleted picture's anchor resolves to the seam
 * it left behind. An import is a range of TEXT — the link the paste landed — and
 * text has no element of its own, so that one reads its own content back the way
 * a link range does.
 */
export function resolvePendingImage(state: EditorState, entry: PendingImage): AnchorRange | null {
  if (entry.kind === "upload") return resolveNodeHold(state, entry.hold);
  const at = resolveAnchorIn(state, entry.hold);
  return at && pastedImageLinkRange(state.doc, at, entry.url);
}

/** The pending picture standing at `pos`, or null. */
export function pendingImageAt(
  pending: PendingImageState,
  state: EditorState,
  pos: number,
): PendingImage | null {
  for (const entry of pending.values()) {
    if (resolvePendingImage(state, entry)?.from === pos) return entry;
  }
  return null;
}

/** Entries whose place in the document is gone: their upload has no landing. */
export function orphanedPendingImages(
  pending: PendingImageState,
  state: EditorState,
): PendingImage[] {
  const orphaned: PendingImage[] = [];
  for (const entry of pending.values()) {
    if (!resolvePendingImage(state, entry)) orphaned.push(entry);
  }
  return orphaned;
}

/**
 * What the manuscript shows for every picture in flight.
 *
 * Node decorations rather than node attributes, for the reason
 * `BlockDragExtension` gives: a pending picture's progress is the document's to
 * show and nobody else's to store, and an attribute written by hand does not
 * survive ProseMirror's own DOM observer.
 *
 * The attributes are the repaint signal as much as the CSS hook. ProseMirror
 * compares decorations by their attributes, so encoding state and progress
 * there is what makes the node view update as the upload moves; the entry
 * itself rides in the spec, which is where the node view reads the label, the
 * reason, and the measured frame.
 */
export function pendingImageDecorations(
  pending: PendingImageState,
  state: EditorState,
): DecorationSet | null {
  if (pending.size === 0) return null;
  const decorations: Decoration[] = [];
  for (const entry of pending.values()) {
    const at = resolvePendingImage(state, entry);
    if (!at) continue;
    decorations.push(
      entry.kind === "upload"
        ? Decoration.node(
            at.from,
            at.to,
            {
              "data-pending-image": entry.status.kind,
              "data-upload-percent":
                entry.status.kind === "uploading" && entry.status.percent !== null
                  ? String(entry.status.percent)
                  : "",
              "data-upload-frame": entry.frame ? `${entry.frame.width}x${entry.frame.height}` : "",
            },
            { pendingImage: entry },
          )
        : Decoration.inline(
            at.from,
            at.to,
            { class: IMPORTING_LINK_CLASS },
            { pendingImage: entry },
          ),
    );
  }
  return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null;
}

/** Marks a link whose picture is being fetched. The link stays a link. */
export const IMPORTING_LINK_CLASS = "meridian-image-importing";

/**
 * The pending picture a node view is rendering, read off the decorations
 * ProseMirror handed it. Null for an ordinary picture, which is nearly all of
 * them.
 */
export function pendingImageFromDecorations(
  decorations: readonly { spec?: unknown }[],
): PendingImageUpload | null {
  for (const decoration of decorations) {
    const entry = (decoration.spec as { pendingImage?: PendingImage } | undefined)?.pendingImage;
    if (entry?.kind === "upload") return entry;
  }
  return null;
}

/**
 * What a node view has to repaint for.
 *
 * A React node view is only re-rendered when its node changes, and a picture in
 * flight never changes its node — that is the whole point. So the node view is
 * given an explicit `update` that compares this, which is exactly the set of
 * facts the decoration's attributes carry: anything ProseMirror can see a
 * difference in, the node view is told about, and nothing else.
 */
export function pendingImageSignature(decorations: readonly { spec?: unknown }[]): string {
  const entry = pendingImageFromDecorations(decorations);
  if (!entry) return "";
  const progress = entry.status.kind === "uploading" ? (entry.status.percent ?? "") : "";
  const frame = entry.frame ? `${entry.frame.width}x${entry.frame.height}` : "";
  return `${entry.id}|${entry.status.kind}|${progress}|${frame}`;
}
