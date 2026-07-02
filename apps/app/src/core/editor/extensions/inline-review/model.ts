/**
 * Inline review model — the client-side view of the server's draft review hunk
 * model. Pure data types plus the anchor-decode helper that converts the
 * server's base64-encoded `Y.RelativePosition` strings back into runtime
 * `RelativePosition` instances the plugin can resolve against the live
 * y-prosemirror binding.
 *
 * Kept free of ProseMirror imports so it can be unit-tested without a DOM.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import * as Y from "yjs";

export type InlineReviewOperationKind = "agent" | "writer";

/** A hunk with anchors already decoded to runtime `Y.RelativePosition`. */
export interface ResolvedReviewHunk {
  hunkId: string;
  operationIds: string[];
  /** Resolves to the start of the insertion / caret for a pure deletion. */
  relStart: Y.RelativePosition;
  /** Resolves to the end of the insertion; equal to `relStart` for pure deletions. */
  relEnd: Y.RelativePosition;
  /** Present when the hunk shows text removed from live but absent in draft. */
  deletedText?: string;
}

/** The full plugin input: hunks + operations + a revision token from the server. */
export interface InlineReviewModel {
  /** Server-issued token identifying the draft state the model was computed against. */
  draftRevisionToken: number;
  operations: ReviewOperation[];
  hunks: ResolvedReviewHunk[];
}

/**
 * Decode a base64 `Y.RelativePosition` produced by the server draft-review
 * hunk pipeline. Returns `null` on malformed input rather than throwing —
 * the plugin degrades to skipping the hunk when an anchor won't decode.
 *
 * A `Y.RelativePosition` is considered valid only when at least one of
 * `type` (nested type id) or `tname` (top-level fragment name) is set;
 * `Y.decodeRelativePosition` will happily accept arbitrary bytes and hand
 * back an all-null position that would silently resolve to nowhere.
 */
export function decodeAnchor(encoded: string): Y.RelativePosition | null {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  try {
    const bytes = base64ToBytes(encoded);
    const decoded = Y.decodeRelativePosition(bytes);
    // Guard against `decodeRelativePosition` returning a fully-null position
    // for bytes that happen to parse but describe nothing addressable.
    if (decoded.type == null && decoded.tname == null) return null;
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
  draftRevisionToken: number;
  operations: ReviewOperation[];
  hunks: ReviewHunk[];
}): InlineReviewModel {
  const resolved: ResolvedReviewHunk[] = [];
  for (const hunk of input.hunks) {
    const relStart = decodeAnchor(hunk.anchor.relStart);
    const relEnd = decodeAnchor(hunk.anchor.relEnd);
    if (!relStart || !relEnd) continue;
    resolved.push({
      hunkId: hunk.hunkId,
      operationIds: hunk.operationIds,
      relStart,
      relEnd,
      ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
    });
  }
  return {
    draftRevisionToken: input.draftRevisionToken,
    operations: input.operations,
    hunks: resolved,
  };
}

/**
 * Kind of the first-listed operation for a hunk drives its highlight color.
 * When a hunk belongs to multiple operations (coalescence), agent kind wins
 * only if every contributing operation is agent — any writer contribution
 * paints the writer color so the writer instantly sees "I touched this."
 */
export function hunkKind(
  hunk: ResolvedReviewHunk,
  operationsById: ReadonlyMap<string, ReviewOperation>,
): InlineReviewOperationKind {
  let sawWriter = false;
  let sawAgent = false;
  for (const opId of hunk.operationIds) {
    const op = operationsById.get(opId);
    if (!op) continue;
    if (op.kind === "writer") sawWriter = true;
    else sawAgent = true;
  }
  if (sawWriter) return "writer";
  if (sawAgent) return "agent";
  // Fall back to agent — treats unknown attribution as AI to preserve the
  // "green = something changed here" reading rather than showing nothing.
  return "agent";
}

/** Index operations by id for O(1) lookup by the plugin. */
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
