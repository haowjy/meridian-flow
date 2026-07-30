/**
 * What the document knows about a picture that has not arrived yet.
 *
 * The design's rule (§5.6): while an upload is in flight the image occupies its
 * FINAL slot as a quiet placeholder, so the manuscript never reflows when the
 * bytes land, and the placeholder is a normal node the writer can MOVE or
 * delete — deleting it cancels the upload, moving it does not.
 *
 * That promise decides the identity. A slot in flight carries one shared fact,
 * the `uploadToken` attribute:
 *
 * - **A move copies it**, because ProseMirror copies a node's attributes and
 *   Yjs carries them with the element. A number would not survive a peer's
 *   write, and a `NodeHold` deliberately would not survive a move (`anchors.ts`
 *   says a Yjs move is a new identity and a held gesture must stop referring to
 *   it) — so a movable slot cannot borrow that identity.
 * - **A peer can read it**, which is the whole difference between "someone is
 *   uploading this right now" and "this was abandoned". WHO is uploading is
 *   ephemeral and travels through awareness (`image-upload-presence.ts`); the
 *   token is what the two facts are joined on.
 * - **Nothing else ever sees it.** It is never rendered to HTML, never parsed
 *   back from one, and no markdown codec emits it — each names the attributes
 *   it writes. The landing clears it in the transaction that writes `src`.
 *
 * Everything that must not be shared stays here, keyed by that same token: how
 * far along the upload is (an attribute would put every percent on the wire and
 * in every peer's undo history), the bytes, and the abort.
 *
 * A pending node's `src` is `""` — the schema's own default, the only source
 * that names nothing. That is the wire-safety decision: an in-flight picture
 * serializes as `![alt]()` and parses back to an empty `src`, so a document
 * saved or synced mid-upload round-trips honestly. The alternative — minting an
 * `asset:` ref before the asset exists — throws in the codec's `pathForAsset`
 * and takes the whole document's serialization with it.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { type AnchorRange, carryAnchor, type EditorAnchor, resolveAnchorIn } from "../anchors";
import { pastedImageLinkRange } from "./image-workflow";

/** The document attribute naming a slot some browser is filling right now. */
export const UPLOAD_TOKEN_ATTR = "uploadToken";

/**
 * The attribute as the schema declares it, shared by `image` and `figure`
 * (Replace aims an upload at a figure too).
 *
 * `rendered: false` keeps it out of every HTML the editor writes, and the
 * explicit `parseHTML` keeps it out of every HTML the editor reads: a clipboard
 * that carried a live token would put two nodes under one upload, and a pasted
 * page could invent one.
 */
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
  /**
   * The upload's identity, and the `uploadToken` written on its slot. One name
   * for one thing: the entry is found from the node and the node from the entry,
   * however the document was rearranged in between.
   */
  id: string;
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
 * refused — so nothing has to be undone. A range of text has no attribute to
 * carry a token on, so this one is anchored the way a link range is.
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

/** Tokens another client is uploading right now, as awareness reports them. */
export type UploadOwnersElsewhere = ReadonlySet<string>;

export const NO_UPLOAD_OWNERS: UploadOwnersElsewhere = new Set();

/** A pending node's source: the one `src` that names nothing. */
export const PENDING_IMAGE_SRC = "";

/**
 * Carry what a transaction can move across its own mapping.
 *
 * Only an import needs it: an upload is found by the token on its node, and
 * every mapping, every move, and every whole-document rebuild carries that
 * along with the node for free.
 */
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

/**
 * Who is filling a slot, as the node view is told it.
 *
 * `"mine"` carries the entry, because this browser is the one that knows the
 * filename, the percent, the failure, and what Retry would mean. `"elsewhere"`
 * carries nothing else: the percent and the bytes never left the browser that
 * has them, and that is the point.
 */
export type PendingUploadOwner =
  | { owner: "mine"; entry: PendingImageUpload }
  | { owner: "elsewhere" };

/**
 * What the manuscript shows for every picture in flight, mine and theirs.
 *
 * Node decorations rather than node attributes, for the reason
 * `BlockDragExtension` gives: a pending picture's progress is the document's to
 * show and nobody else's to store, and an attribute written by hand does not
 * survive ProseMirror's own DOM observer.
 *
 * The attributes are the repaint signal as much as the CSS hook. ProseMirror
 * compares decorations by their attributes, so encoding owner and progress
 * there is what makes the node view update as the upload moves; the owner
 * itself rides in the spec, which is where the node view reads the label, the
 * reason, and the measured frame.
 *
 * A token nobody claims gets NO decoration. That is the honest reading of a
 * reload's leftover or a redone insert whose bytes are gone, and it is the one
 * state where the node view may offer Remove.
 */
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
            ? { owner: "elsewhere" }
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
  const frame = pending.owner === "mine" ? pending.entry.frame : null;
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

/**
 * Who is filling the slot a node view is rendering, read off the decorations
 * ProseMirror handed it. Null for an ordinary picture, which is nearly all of
 * them, and for a slot nobody claims.
 */
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
  const pending = pendingUploadFromDecorations(decorations);
  if (!pending) return "";
  if (pending.owner === "elsewhere") return "elsewhere";
  const { entry } = pending;
  const progress = entry.status.kind === "uploading" ? (entry.status.percent ?? "") : "";
  const frame = entry.frame ? `${entry.frame.width}x${entry.frame.height}` : "";
  return `${entry.id}|${entry.status.kind}|${progress}|${frame}`;
}
