/**
 * Inline review model — the client-side view of the server's draft review hunk
 * model. Pure data types plus the anchor-decode helper that converts the
 * server's base64-encoded `Y.RelativePosition` strings back into runtime
 * `RelativePosition` instances the plugin can resolve against the live
 * y-prosemirror binding.
 *
 * Kept free of ProseMirror imports so it can be unit-tested without a DOM.
 */
import type {
  ReviewBlockHunk,
  ReviewHunk,
  ReviewOperation,
  ReviewTextHunk,
} from "@meridian/contracts/drafts";
import * as Y from "yjs";

export type InlineReviewOperationKind = "agent" | "writer";

const UNATTRIBUTED_PREFIX = "unattributed:";

/**
 * The key a hunk with no owning operation is painted, focused and scrolled to
 * by. Operations are how every other mark is found (`data-review-operations`),
 * and an unclassified hunk has none, so the model gives it this stand-in. It is
 * a client-side name only: it never reaches the server and no command takes it.
 */
export function unattributedHunkKey(hunkId: string): string {
  return `${UNATTRIBUTED_PREFIX}${hunkId}`;
}

export function isUnattributedHunkKey(key: string): boolean {
  return key.startsWith(UNATTRIBUTED_PREFIX);
}

/**
 * A per-operation piece of an inserted hunk. Every inserted character is
 * covered by exactly one span, so nested authorship (e.g. a writer edit
 * inside an AI insertion) is expressed as adjacent spans that render in
 * their owner's color. The union of a hunk's spans equals its full
 * insertion range.
 */
export interface ResolvedReviewSpan {
  operationId: string;
  from: Y.RelativePosition;
  to: Y.RelativePosition;
}

/** Runtime anchors replace the wire-encoded anchor pair. */
interface DecodedReviewAnchors {
  relStart: Y.RelativePosition;
  relEnd: Y.RelativePosition;
}

/** Text presentation is unchanged; only anchors and insertion spans are decoded. */
export interface ResolvedTextReviewHunk
  extends Omit<ReviewTextHunk, "anchor" | "spans" | "insertedText">,
    DecodedReviewAnchors {
  spans: ResolvedReviewSpan[];
}

/** Block presentation is unchanged; only its anchor pair is decoded. */
export interface ResolvedBlockReviewHunk
  extends Omit<ReviewBlockHunk, "anchor">,
    DecodedReviewAnchors {}

/** A hunk with anchors already decoded to runtime `Y.RelativePosition`. */
export type ResolvedReviewHunk = ResolvedTextReviewHunk | ResolvedBlockReviewHunk;

/** The full plugin input: hunks + operations + a revision token from the server. */
export interface InlineReviewModel {
  /** Server-issued token identifying the live base the model was computed against. */
  liveRevisionToken?: string;
  /** Server-issued token identifying the draft state the model was computed against. */
  draftRevisionToken: string;
  operations: ReviewOperation[];
  hunks: ResolvedReviewHunk[];
}

/**
 * Decode a base64 `Y.RelativePosition` produced by the server draft-review
 * hunk pipeline. Returns `null` on malformed input rather than throwing —
 * the plugin degrades to skipping the hunk when an anchor won't decode.
 *
 * A `Y.RelativePosition` addresses one of three things: `tname` (top-level
 * fragment name), `type` (a nested Y.AbstractType id), or `item` (a specific
 * CRDT item by `{client, clock}` — the common case for anchoring to a
 * character position in text). `Y.decodeRelativePosition` accepts arbitrary
 * bytes and hands back an all-null position; reject only when all three
 * addressability channels are absent.
 */
export function decodeAnchor(encoded: string): Y.RelativePosition | null {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  try {
    const bytes = base64ToBytes(encoded);
    const decoded = Y.decodeRelativePosition(bytes);
    if (decoded.type == null && decoded.tname == null && decoded.item == null) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Build an `InlineReviewModel` from a raw server response. Hunks with
 * un-decodable anchors are dropped — a stale/corrupted anchor should never
 * crash review; it just means one hunk is invisible until the next refetch.
 */
export function buildInlineReviewModel(input: {
  liveRevisionToken?: string;
  draftRevisionToken: string;
  operations: ReviewOperation[];
  hunks: ReviewHunk[];
}): InlineReviewModel {
  const resolved: ResolvedReviewHunk[] = [];
  for (const hunk of input.hunks) {
    const relStart = decodeAnchor(hunk.anchor.relStart);
    const relEnd = decodeAnchor(hunk.anchor.relEnd);
    if (!relStart || !relEnd) continue;
    const base = {
      hunkId: hunk.hunkId,
      operationIds:
        hunk.operationIds.length > 0 ? hunk.operationIds : [unattributedHunkKey(hunk.hunkId)],
      relStart,
      relEnd,
      ...(hunk.unclassified ? { unclassified: true } : {}),
      ...(hunk.mergeArtifact ? { mergeArtifact: true } : {}),
    };
    if (hunk.kind === "block") {
      resolved.push({
        ...base,
        kind: "block",
        ...(hunk.insertedBlock ? { insertedBlock: hunk.insertedBlock } : {}),
        ...(hunk.deletedBlock ? { deletedBlock: hunk.deletedBlock } : {}),
      });
      continue;
    }
    // Spans are optional at wire-level — a text hunk with no spans falls back
    // to whole-hunk coloring by the plugin. Drop malformed span anchors
    // instead of dropping the hunk; a missing span just paints as its
    // neighbour.
    const spans: ResolvedReviewSpan[] = [];
    for (const span of hunk.spans) {
      const from = decodeAnchor(span.anchorFrom);
      const to = decodeAnchor(span.anchorTo);
      if (!from || !to) continue;
      spans.push({ operationId: span.operationId, from, to });
    }
    resolved.push({
      ...base,
      kind: "text",
      spans,
      ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
      ...(hunk.deletedSpans ? { deletedSpans: hunk.deletedSpans } : {}),
    });
  }
  return {
    ...(input.liveRevisionToken === undefined
      ? {}
      : { liveRevisionToken: input.liveRevisionToken }),
    draftRevisionToken: input.draftRevisionToken,
    operations: input.operations,
    hunks: resolved,
  };
}

/**
 * How a hunk's marks are drawn: an author's colour, or `neutral` when no
 * author can be named. A merge artifact (concurrent edits the CRDT combined)
 * and an unclassified hunk (no operation owns it) are neutral whatever their
 * operations say, so text and block rendering share this one decision.
 * Otherwise a hunk with a writer contribution paints the writer colour (the
 * writer instantly sees "I touched this"), and any other known operation
 * paints the AI's. A hunk whose operations are all unknown reads as the AI's,
 * so the change is still seen.
 */
export type ReviewTone = InlineReviewOperationKind | "neutral";

export function hunkTone(
  hunk: ResolvedReviewHunk,
  operationsById: ReadonlyMap<string, ReviewOperation>,
): ReviewTone {
  if (hunk.mergeArtifact === true || hunk.unclassified === true) return "neutral";
  for (const opId of hunk.operationIds) {
    if (operationsById.get(opId)?.kind === "writer") return "writer";
  }
  return "agent";
}

/** Who a removed stretch is drawn as: an author, or `unattributed` when the server could not say. */
export type RemovalKind = InlineReviewOperationKind | "unattributed";

/**
 * Who removed the live block a block hunk shows struck. The preview carries no
 * per-removal author for blocks, only the hunk's owning operations, so the
 * removal is the writer's when every owning operation is the writer's and the
 * AI's otherwise; unattributed when the hunk is neutral. (Text hunks say who
 * removed each stretch: `deletedSpans`.)
 */
export function blockRemovalKind(
  hunk: ResolvedBlockReviewHunk,
  operationsById: ReadonlyMap<string, ReviewOperation>,
): RemovalKind {
  if (hunkTone(hunk, operationsById) === "neutral") return "unattributed";
  let sawWriter = false;
  for (const opId of hunk.operationIds) {
    const op = operationsById.get(opId);
    if (op?.kind === "writer") sawWriter = true;
    else return "agent";
  }
  return sawWriter ? "writer" : "agent";
}

/**
 * The operations that make up the one change the active operation belongs to.
 * Operations sharing a server closure class overlap, so the writer sees and
 * acts on them as a single change; focusing one focuses them all.
 */
export function changeOperationIds(
  operations: readonly ReviewOperation[],
  activeOperationId: string | null,
): ReadonlySet<string> {
  if (!activeOperationId) return new Set();
  const active = operations.find((op) => op.operationId === activeOperationId);
  const ids = new Set([activeOperationId]);
  if (!active) return ids;
  for (const op of operations) {
    if (op.closureClassId === active.closureClassId) ids.add(op.operationId);
  }
  return ids;
}

export function indexOperations(
  operations: readonly ReviewOperation[],
): Map<string, ReviewOperation> {
  const map = new Map<string, ReviewOperation>();
  for (const op of operations) map.set(op.operationId, op);
  return map;
}

function base64ToBytes(input: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(input);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  // Node fallback for unit tests / SSR paths.
  return new Uint8Array(Buffer.from(input, "base64"));
}
