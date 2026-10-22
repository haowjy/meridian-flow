/**
 * The reserved server client and the pure conversion of a pre-`review_base` (legacy) prose draft.
 *
 * A legacy draft kept `live_cut`, live's Yjs state at its last pull, and no base fragment. Conversion
 * writes that cut's text into `review_base`, so the
 * first content rebase merges live's edits since the cut and a paragraph the writer deleted stays
 * deleted. Pure bytes in, bytes out: the migration that persists it owns the CAS.
 */

import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { blocksEqual } from "./equal.js";
import { REVIEW_BASE_FRAGMENT, readBlocks } from "./fragments.js";
import { writeBlocks } from "./writer.js";

/**
 * Every server write into a draft room (seed, rebase, conversion) uses this reserved-band client, so a
 * draft's server-authored structs are one append-only clock range and no browser can forge them
 * (inbound structs from the band are rejected at ingest).
 */
export const DRAFT_SERVER_CLIENT_ID = 1;

export type LegacyDraftConversion =
  | { kind: "converted"; state: Uint8Array; stateVector: Uint8Array; hasEffect: boolean }
  | { kind: "unresolved"; reason: "no_live_cut" };

/** Converts one legacy prose draft from its live cut; a missing cut is unresolved, never a guess. */
export function convertLegacyDraft(input: {
  state: Uint8Array;
  liveCut: Uint8Array | null;
}): LegacyDraftConversion {
  const schema = buildDocumentSchema();
  const doc = createCollabYDoc({ gc: false });
  const cut = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(doc, input.state);
    const draftFragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    if (!input.liveCut) return { kind: "unresolved", reason: "no_live_cut" };
    Y.applyUpdate(cut, input.liveCut);
    const base = readBlocks(cut.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
    doc.clientID = DRAFT_SERVER_CLIENT_ID;
    doc.transact(
      () => writeBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema, base),
      "convert-legacy-draft",
    );
    return {
      kind: "converted",
      state: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
      hasEffect: !blocksEqual(readBlocks(draftFragment, schema), base),
    };
  } finally {
    doc.destroy();
    cut.destroy();
  }
}
