/**
 * The removed text a writer can get back: what the binding's schema repair deleted, read from
 * the pre-repair document and the repair's delete set.
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

function deletedSlices(item: Y.Item, deleteSet: DeleteSet): Array<{ from: number; to: number }> {
  const ranges = deleteSet.clients.get(item.id.client);
  if (!ranges) return [];
  const itemStart = item.id.clock;
  const itemEnd = itemStart + item.length;
  const slices: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const from = Math.max(itemStart, range.clock);
    const to = Math.min(itemEnd, range.clock + range.len);
    if (from < to) slices.push({ from: from - itemStart, to: to - itemStart });
  }
  return slices;
}

/**
 * Resolve delete-set clocks against the pre-repair clone's item graph.
 *
 * Traversal follows Y item identity and logical XML order. It never compares
 * sibling positions between before and after documents, which would be
 * ambiguous when repeated or nested siblings have the same shape.
 */
export function extractEvidenceFromFragment(
  fragment: Y.XmlFragment,
  deleteSet: DeleteSet,
): ExtractedEvidence {
  const deletedNodeTypes: string[] = [];
  let resolvedClockCount = 0;
  let contentUnavailable = false;
  type TextToken = { kind: "text"; text: string } | { kind: "boundary" };
  const walk = (start: Y.Item | null): TextToken[] => {
    const tokens: TextToken[] = [];
    for (let item = start; item; item = item.right) {
      const slices = deletedSlices(item, deleteSet);
      const content = item.content;
      resolvedClockCount += slices.reduce((total, slice) => total + slice.to - slice.from, 0);
      if (content instanceof Y.ContentString) {
        const text = slices.map((slice) => content.str.slice(slice.from, slice.to)).join("");
        if (text) tokens.push({ kind: "text", text });
      } else if (slices.length > 0 && content instanceof Y.ContentDeleted) {
        contentUnavailable = true;
      }
      if (!(content instanceof Y.ContentType)) continue;
      const child = content.type;
      const nodeName = child instanceof Y.XmlElement ? child.nodeName : undefined;
      if (slices.length > 0 && nodeName && !deletedNodeTypes.includes(nodeName)) {
        deletedNodeTypes.push(nodeName);
      }
      if (nodeName) tokens.push({ kind: "boundary" });
      tokens.push(...walk(child._start));
      if (nodeName) tokens.push({ kind: "boundary" });
    }
    return tokens;
  };

  let text = "";
  let boundary = false;
  for (const token of walk(fragment._start)) {
    if (token.kind === "boundary") {
      if (text) boundary = true;
      continue;
    }
    if (boundary) text += "\n";
    text += token.text;
    boundary = false;
  }

  return {
    evidence: {
      deletedNodeTypes,
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
