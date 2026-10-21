/** Apply evidence for immutable receipt ranges, including AI items restored by Undo before Apply. */
import type * as Y from "yjs";
import { type ApplyEntry, readApplyRecord } from "./apply-record.js";
import type { AttributionPart } from "./attribution.js";
import { IdIndex, type ItemRange, indexRanges } from "./id-index.js";
import { readRestorations } from "./restorations.js";

/**
 * Positive Apply evidence wins even when another portion of the receipt is still pending.
 * Receipt ranges include structural and writer-deleted items, so full coverage is not required.
 * Deletion evidence always addresses current IDs; only insertion birth follows restoration links.
 */
export function appliedParts(
  doc: Y.Doc,
  parts: readonly Pick<AttributionPart, "inserted" | "deleted">[],
  record: readonly ApplyEntry[] = readApplyRecord(doc),
): boolean[] {
  const links = readRestorations(doc).links;
  const linkIndex = new IdIndex(links.map(([c, k, n], i) => [c, k, n, i] as const));
  const base: ItemRange[] = record.flatMap((entry) => entry.base);
  const seen = new Set<string>();
  const depths = base.map(() => 0);
  const maxDepth = linkIndex.size;
  for (let i = 0; i < base.length; i++) {
    const [client, clock, length] = base[i];
    const key = `${client}:${clock}:${length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (depths[i] >= maxDepth) continue;
    for (let from = clock; from < clock + length; ) {
      const [tag, run] = linkIndex.run(client, from);
      const end = Math.min(clock + length, from + run);
      if (tag >= 0) {
        const [, start, , toClient, toClock] = links[tag];
        base.push([toClient, toClock + from - start, end - from]);
        depths.push(depths[i] + 1);
      }
      from = end;
    }
  }
  const inserted = indexRanges([base]);
  const deleted = indexRanges([record.flatMap((entry) => entry.settled)]);
  return parts.map(
    (part) =>
      part.inserted.some(([c, k, n]) => inserted.overlaps(c, k, n)) ||
      part.deleted.some(([c, k, n]) => deleted.overlaps(c, k, n)),
  );
}
