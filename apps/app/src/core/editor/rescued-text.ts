/**
 * Text a writer can get back, read from Yjs items: the words a schema repair deleted (the
 * pre-repair document and the repair's delete set), and the typing a room never delivered (the
 * room's document and its unacknowledged updates).
 */
import { textInRanges } from "@meridian/agent-edit/yjs-mutation";
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

/** Every word `document` holds, one line per block; null when it holds none. */
export function documentText(document: Y.Doc): string | null {
  const all = new Map(
    [...Y.decodeStateVector(Y.encodeStateVector(document))].map(([client, clock]) => [
      client,
      [{ clock: 0, len: clock }],
    ]),
  );
  const { text } = textInRanges(
    document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    { clients: all },
    { liveOnly: true },
  );
  return text || null;
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
    { liveOnly: true },
  );
  return text || null;
}
