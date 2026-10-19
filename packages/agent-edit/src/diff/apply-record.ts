/**
 * The Apply record: which draft items an Apply moved into the review base.
 *
 * The server appends one entry per Apply to a server-owned root of the draft doc, as the reserved server
 * client, in the same write that moves `review_base`. `base` holds the applied changes' non-base items
 * (their text is now the base's); `settled` holds the tombstones at their deletion points (those deletions
 * are now in the base). Entries are plain id ranges, so splits of an item never invalidate them.
 */
import type * as Y from "yjs";
import { DRAFT_SERVER_CLIENT_ID } from "./draft-base.js";
import type { ItemRange } from "./id-index.js";

export const APPLY_RECORD_ROOT = "__meridian_review_applied_v1";

export interface ApplyEntry {
  commandId?: string;
  base: ItemRange[];
  settled: ItemRange[];
}

/** Every entry the server wrote; anything else in the root (a forged item) is ignored. */
export function readApplyRecord(doc: Y.Doc): ApplyEntry[] {
  const root = doc.share.get(APPLY_RECORD_ROOT);
  if (!root) return [];
  const out: ApplyEntry[] = [];
  for (let item = (root as Y.Array<unknown>)._start; item; item = item.right) {
    if (item.deleted || item.id.client !== DRAFT_SERVER_CLIENT_ID) continue;
    for (const entry of item.content.getContent() as Array<Partial<ApplyEntry> | null>)
      if (entry && Array.isArray(entry.base) && Array.isArray(entry.settled))
        out.push({
          base: entry.base,
          settled: entry.settled,
          ...(typeof entry.commandId === "string" ? { commandId: entry.commandId } : {}),
        });
  }
  return out;
}

/** Append one entry. The caller owns the transaction and has set the doc's client to the server's. */
export function appendApplyRecord(doc: Y.Doc, entry: ApplyEntry): void {
  doc.getArray<ApplyEntry>(APPLY_RECORD_ROOT).push([entry]);
}
