/**
 * The rebase history of a draft, kept as exact causal cuts. A rebase deletes and re-creates text on the
 * server's behalf, and nothing journals it, so a later peer update that was authored before the rebase
 * cannot be placed against the doc as it is now. Each rebase that changes the draft therefore keeps an
 * encoded `Y.Snapshot` (state vector and delete set) of the draft just before it. Late-peer recovery
 * rebuilds "the block as the peer saw it" from the latest cut at which the touched items were still alive.
 *
 * The cuts live outside the document, in `document_branches.rebase_cuts`, written in the same CAS as
 * the rebase. Each is a state vector plus a delete set, so the column is bounded by the caps below,
 * not by the number of rebases.
 */
import * as Y from "yjs";

/** Older cuts are dropped: a peer behind by more rebases than this is recovered without context. */
export const MAX_REBASE_CUTS = 32;

/** The column's total size cap, oldest dropped first. */
export const MAX_REBASE_CUT_BYTES = 1024 * 1024;

/** The cut to keep if the rebase about to run changes `doc`. Take it before writing. */
export function captureRebaseCut(doc: Y.Doc): Uint8Array {
  return Y.encodeSnapshot(Y.snapshot(doc));
}

/** `cuts` (oldest first) with `cut` appended, trimmed to the newest entries within both caps. */
export function appendRebaseCut(cuts: readonly Uint8Array[], cut: Uint8Array): Uint8Array[] {
  const kept = [...cuts, cut].slice(-MAX_REBASE_CUTS);
  let bytes = kept.reduce((total, entry) => total + entry.byteLength, 0);
  // The newest cut always stays, even if it alone is over the byte cap.
  while (kept.length > 1 && bytes > MAX_REBASE_CUT_BYTES) {
    bytes -= kept.shift()?.byteLength ?? 0;
  }
  return kept;
}

/** The decoded cuts, oldest first. */
export function decodeRebaseCuts(cuts: readonly Uint8Array[]): Y.Snapshot[] {
  return cuts.map((bytes) => Y.decodeSnapshot(bytes));
}
