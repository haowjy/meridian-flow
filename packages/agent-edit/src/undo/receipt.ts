// What a write did to the text's items, recorded with its receipt.
import * as Y from "yjs";
import {
  intersectLineageRanges,
  type LineageRange,
  normalizeLineageRanges,
  subtractLineageRanges,
} from "../lineage/range-set.js";
import { itemIsInFragment, itemsInRange } from "../yjs-mutation.js";
import { withoutClocks } from "./held-deletes.js";

export interface EditRange {
  client: number;
  clock: number;
  len: number;
}
export interface EditEffect {
  inserted: EditRange[];
  deleted: EditRange[];
}
export interface EditTarget {
  editId: string;
  ordinal: number;
}
export type EditKind = "write" | "undo" | "revert";
export interface CapturedPart {
  update: Uint8Array;
  effect: EditEffect;
}

const lineageRange = (range: EditRange): LineageRange => ({
  clientID: range.client,
  clock: range.clock,
  length: range.len,
});
const editRange = (range: LineageRange): EditRange => ({
  client: range.clientID,
  clock: range.clock,
  len: range.length,
});
const normalizedRanges = (ranges: readonly EditRange[]): EditRange[] =>
  normalizeLineageRanges(ranges.map(lineageRange)).map(editRange);
function proseRanges(doc: Y.Doc, input: readonly EditRange[]): EditRange[] {
  const out: EditRange[] = [];
  for (const range of input)
    for (const { item, clock, len } of itemsInRange(doc, range))
      if (itemIsInFragment(doc, item, "prosemirror"))
        out.push({ client: range.client, clock, len });
  return normalizedRanges(out);
}
function rawEffect(update: Uint8Array, held?: ReadonlySet<string>): EditEffect {
  const decoded = Y.decodeUpdate(update);
  return {
    inserted: normalizedRanges(
      decoded.structs
        .filter((s): s is Y.Item => s instanceof Y.Item)
        .map((s) => ({ client: s.id.client, clock: s.id.clock, len: s.length })),
    ),
    deleted: normalizedRanges(
      withoutClocks(
        [...decoded.ds.clients].flatMap(([client, rs]) =>
          rs.map((r) => ({ client, clock: r.clock, len: r.len })),
        ),
        held,
      ),
    ),
  };
}

/**
 * Normalize the whole write together, excluding cross-part transients and non-prose roots.
 * `held` is `heldDeletes` taken before the update applied: a delete of an item the room had
 * already deleted is not the update's effect.
 */
export function captureEditParts(
  doc: Y.Doc,
  receipts: readonly { update: Uint8Array; held?: ReadonlySet<string> }[],
): CapturedPart[] {
  const raw = receipts.map((r) => rawEffect(r.update, r.held));
  const inserted = normalizedRanges(raw.flatMap((effect) => effect.inserted)),
    deleted = normalizedRanges(raw.flatMap((effect) => effect.deleted)),
    transient = intersectLineageRanges(inserted.map(lineageRange), deleted.map(lineageRange));
  const outside = (input: readonly EditRange[]) =>
    subtractLineageRanges(input.map(lineageRange), transient).map(editRange);
  return receipts.map((receipt, i) => ({
    update: receipt.update,
    effect: {
      inserted: outside(proseRanges(doc, raw[i].inserted)),
      deleted: outside(proseRanges(doc, raw[i].deleted)),
    },
  }));
}
