/**
 * Text a writer can get back, read from Yjs items: the words a schema repair deleted (the
 * pre-repair document and the repair's delete set), and the typing a room never delivered (the
 * room's document and its unacknowledged updates).
 */
import { textInRanges } from "@meridian/agent-edit/yjs-mutation";
import * as Y from "yjs";

import { insertedBy, type Ranges } from "./item-ranges";
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

/** The live words of the items in `ranges`; null when they hold none. */
export function typedText(document: Y.Doc, ranges: Ranges): string | null {
  const clients = new Map(
    [...ranges].map(([client, list]) => [
      client,
      list.map(([from, to]) => ({ clock: from, len: to - from })),
    ]),
  );
  const { text } = textInRanges(
    document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    { clients },
    { liveOnly: true },
  );
  return text || null;
}

/** `read` on `copy` (an update) in a scratch document, which lives until `read` settles. */
export async function readCopy<T>(copy: Uint8Array, read: (document: Y.Doc) => T | Promise<T>) {
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, copy);
    return await read(scratch);
  } finally {
    scratch.destroy();
  }
}

/** `read` on the items of `copy` (an update) beyond `server` (a state vector), in a scratch document. */
export function readBeyond<T>(
  copy: Uint8Array,
  server: Uint8Array,
  read: (document: Y.Doc, lacking: Ranges) => T | Promise<T>,
) {
  return readCopy(copy, (document) =>
    read(document, insertedBy(Y.encodeStateAsUpdate(document, server))),
  );
}
