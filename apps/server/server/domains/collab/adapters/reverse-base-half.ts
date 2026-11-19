/** An Un-Apply's half on a draft: its text out of the review base, its Apply records out of the draft. */
import {
  addCounts,
  contentMerge,
  type RuleCounts,
  ruleCounter,
} from "@meridian/agent-edit/content-merge";
import {
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  removeApplyRecords,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";

const schema = buildDocumentSchema();

/** One Apply's effects on one draft that an Un-Apply takes out of the draft's base. */
export type BaseReversal = {
  applyCommandId: string;
  /** Every group the Un-Apply took back, those with no live write included. */
  groupIds: ReadonlySet<string>;
  /** The groups with a live write, oldest first: their text is merged out of the base. */
  merges: { baseBefore: unknown[]; baseAfter: unknown[] }[];
};

/**
 * Takes the Un-Apply's text out of the draft's base and its Apply records out of the draft, in
 * one transaction of the prefix. Returns the rows to append.
 */
export function reverseBaseHalf(
  prefix: Y.Doc,
  reversal: BaseReversal,
): { rows: Uint8Array[]; rules: RuleCounts; overrode: number } {
  let row: Uint8Array | undefined;
  const capture = (bytes: Uint8Array) => {
    row = bytes;
  };
  const total = ruleCounter();
  let overrode = 0;
  prefix.on("update", capture);
  try {
    prefix.transact(() => {
      const fragment = prefix.getXmlFragment(REVIEW_BASE_FRAGMENT);
      let current = readBlocks(fragment, schema);
      for (const effect of [...reversal.merges].reverse()) {
        const merge = contentMerge(
          schema,
          effect.baseAfter.map((node) => schema.nodeFromJSON(node)),
          current,
          effect.baseBefore.map((node) => schema.nodeFromJSON(node)),
        );
        addCounts(total.fire, merge.rules);
        overrode += merge.overrode;
        current = merge.blocks;
      }
      writeBlocks(fragment, schema, current);
      removeApplyRecords(prefix, reversal.applyCommandId, reversal.groupIds);
    }, "unapply");
  } finally {
    prefix.off("update", capture);
  }
  if (!row) throw new Error("Un-Apply must remove its Apply records");
  return { rows: [row], rules: total.counts, overrode };
}
