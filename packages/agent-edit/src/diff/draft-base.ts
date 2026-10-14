/**
 * The draft's base identity and the pure conversion of a pre-`review_base` (legacy) prose draft.
 *
 * A legacy draft kept `live_cut`, live's Yjs state at its last pull, and no base fragment. Conversion
 * writes that cut's text into `review_base` and stamps the initialized-but-unknown base revision, so the
 * first content rebase merges live's edits since the cut and a paragraph the writer deleted stays
 * deleted. Pure bytes in, bytes out: the migration that persists it owns the CAS.
 */

import type { DraftBaseRevision } from "@meridian/contracts";
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

/**
 * The base revision of a base that is initialized but older than every live revision: a fresh seed
 * (whose revision the caller does not know) and a converted legacy draft. Null `base_revision` on a
 * prose draft means no base was ever written, which only a pre-rebase draft can be.
 */
export const UNKNOWN_BASE_REVISION: DraftBaseRevision = {
  authorityId: "",
  authorityGeneration: "0",
  seq: 0,
};

export type LegacyDraftConversion =
  | { kind: "converted"; state: Uint8Array; stateVector: Uint8Array; hasEffect: boolean }
  | { kind: "unresolved"; reason: "no_live_cut" };

/**
 * Converts one legacy prose draft. With a `liveCut` the base is that cut's text. Without one the base
 * is the draft's own text, but only when legacy state proves the draft is unchanged from its cut:
 * `hadEffect` false, or nothing was ever written to it. Anything else is `unresolved`, never a guess.
 */
export function convertLegacyDraft(input: {
  state: Uint8Array;
  liveCut: Uint8Array | null;
  hadEffect: boolean;
}): LegacyDraftConversion {
  const schema = buildDocumentSchema();
  const doc = createCollabYDoc({ gc: false });
  const cut = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(doc, input.state);
    const draftFragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    let base: ReturnType<typeof readBlocks>;
    if (input.liveCut) {
      Y.applyUpdate(cut, input.liveCut);
      base = readBlocks(cut.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
    } else if (!input.hadEffect || doc.store.clients.size === 0) {
      base = readBlocks(draftFragment, schema);
    } else {
      return { kind: "unresolved", reason: "no_live_cut" };
    }
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
