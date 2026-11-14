/**
 * Text a writer can get back, read from Yjs items: the words a schema repair deleted (the
 * pre-repair document and the repair's delete set), and the typing a room never delivered (the
 * room's document and its unacknowledged updates).
 */
import * as Y from "yjs";

import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

export type SchemaRepairEvidence = {
  deletedNodeTypes: string[];
  deletedClockCount: number;
  /** Full removed prose, session-scoped. */
  removedText?: string;
};

// Yjs exports DeleteSet's constructor only through internals; its typed shape
// is reachable from the public Transaction.
type DeleteSet = Y.Transaction["deleteSet"];
/** Item clock ranges by client: a delete set, or the items an update inserts. */
type ItemRanges = { clients: Map<number, ReadonlyArray<{ clock: number; len: number }>> };
export type ExtractedEvidence = {
  evidence: SchemaRepairEvidence;
  resolvedClockCount: number;
  contentUnavailable: boolean;
};

export function deletedClockCount(deleteSet: DeleteSet): number {
  let total = 0;
  for (const ranges of deleteSet.clients.values()) {
    for (const range of ranges) total += range.len;
  }
  return total;
}

function slicesIn(item: Y.Item, ranges: ItemRanges): Array<{ from: number; to: number }> {
  const clientRanges = ranges.clients.get(item.id.client);
  if (!clientRanges) return [];
  const itemStart = item.id.clock;
  const itemEnd = itemStart + item.length;
  const slices: Array<{ from: number; to: number }> = [];
  for (const range of clientRanges) {
    const from = Math.max(itemStart, range.clock);
    const to = Math.min(itemEnd, range.clock + range.len);
    if (from < to) slices.push({ from: from - itemStart, to: to - itemStart });
  }
  return slices;
}

/**
 * The text of the items in `ranges`, in document order, one line per block; with `liveOnly`,
 * only items nothing has deleted (a repair's items are already deleted when the live witness
 * reads them). Text outside the ranges between two kept runs starts a new line too, so typing in
 * two places never reads as one word.
 *
 * Traversal follows Y item identity and logical XML order. It never compares
 * sibling positions between before and after documents, which would be
 * ambiguous when repeated or nested siblings have the same shape.
 */
function textInRanges(fragment: Y.XmlFragment, ranges: ItemRanges, liveOnly = false) {
  const nodeTypes: string[] = [];
  let resolvedClockCount = 0;
  let contentUnavailable = false;
  let text = "";
  let pendingBreak = false;
  const walk = (start: Y.Item | null) => {
    for (let item = start; item; item = item.right) {
      const slices = slicesIn(item, ranges);
      const content = item.content;
      resolvedClockCount += slices.reduce((total, slice) => total + slice.to - slice.from, 0);
      if (content instanceof Y.ContentString && !(liveOnly && item.deleted)) {
        const kept = slices.map((slice) => content.str.slice(slice.from, slice.to)).join("");
        if (kept.length < content.str.length && text) pendingBreak = true;
        if (kept) {
          if (pendingBreak) text += "\n";
          text += kept;
          pendingBreak = false;
        }
      } else if (slices.length > 0 && content instanceof Y.ContentDeleted) {
        contentUnavailable = true;
      }
      if (!(content instanceof Y.ContentType)) continue;
      const child = content.type;
      const nodeName = child instanceof Y.XmlElement ? child.nodeName : undefined;
      if (slices.length > 0 && nodeName && !nodeTypes.includes(nodeName)) nodeTypes.push(nodeName);
      if (nodeName && text) pendingBreak = true;
      walk(child._start);
      if (nodeName && text) pendingBreak = true;
    }
  };
  walk(fragment._start);
  return { text, nodeTypes, resolvedClockCount, contentUnavailable };
}

/** Resolve a repair's delete-set clocks against the pre-repair clone's item graph. */
export function extractEvidenceFromFragment(
  fragment: Y.XmlFragment,
  deleteSet: DeleteSet,
): ExtractedEvidence {
  const { text, nodeTypes, resolvedClockCount, contentUnavailable } = textInRanges(
    fragment,
    deleteSet,
  );
  return {
    evidence: {
      deletedNodeTypes: nodeTypes,
      deletedClockCount: deletedClockCount(deleteSet),
      ...(text ? { removedText: text } : {}),
    },
    resolvedClockCount,
    contentUnavailable,
  };
}

export function extractSchemaRepairEvidence(
  preRepairSnapshot: Uint8Array,
  repairUpdate: Uint8Array,
): SchemaRepairEvidence {
  const deleteSet = Y.decodeUpdate(repairUpdate).ds;
  const snapshot = new Y.Doc({ gc: false });
  Y.applyUpdate(snapshot, preRepairSnapshot);
  const { evidence } = extractEvidenceFromFragment(
    snapshot.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    deleteSet,
  );
  snapshot.destroy();
  return evidence;
}

/**
 * The words this browser typed into `document` that the server never acknowledged: the text
 * `unacknowledged` inserted and nothing has deleted since. Null when it holds no words (a format
 * change, a deletion).
 */
export function unsentText(document: Y.Doc, unacknowledged: Uint8Array): string | null {
  const inserted = new Map<number, { clock: number; len: number }[]>();
  for (const struct of Y.decodeUpdate(unacknowledged).structs) {
    if (!(struct instanceof Y.Item)) continue;
    const ranges = inserted.get(struct.id.client) ?? [];
    ranges.push({ clock: struct.id.clock, len: struct.length });
    inserted.set(struct.id.client, ranges);
  }
  const { text } = textInRanges(
    document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    { clients: inserted },
    true,
  );
  return text || null;
}
