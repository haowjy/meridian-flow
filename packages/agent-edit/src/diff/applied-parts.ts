/** Apply evidence for immutable receipt ranges, including AI items restored by Undo before Apply. */
import type * as Y from "yjs";
import { type ApplyEntry, readApplyRecord } from "./apply-record.js";
import type { AttributionPart } from "./attribution.js";
import type { ItemRange } from "./id-index.js";
import { readRestorations } from "./restorations.js";

/** Disjoint intervals per client; merges evidence once and answers receipt overlap in O(log n). */
function evidence(ranges: readonly ItemRange[]) {
  const clients = new Map<number, [number, number][]>();
  for (const [client, clock, length] of ranges) {
    if (length <= 0) continue;
    const list = clients.get(client) ?? [];
    list.push([clock, clock + length]);
    clients.set(client, list);
  }
  for (const [client, list] of clients) {
    list.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of list) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push(range);
    }
    clients.set(client, merged);
  }
  return (ranges: readonly ItemRange[]) =>
    ranges.some(([client, clock, length]) => {
      const list = clients.get(client);
      if (!list || length <= 0) return false;
      let lo = 0,
        hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (list[mid][1] <= clock) lo = mid + 1;
        else hi = mid;
      }
      return lo < list.length && list[lo][0] < clock + length;
    });
}

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
  type Link = { from: number; to: number; client: number; clock: number };
  const links = new Map<number, Link[]>();
  for (const [client, clock, length, toClient, toClock] of readRestorations(doc).links) {
    const list = links.get(client) ?? [];
    list.push({ from: clock, to: clock + length, client: toClient, clock: toClock });
    links.set(client, list);
  }
  // The classifier's IdIndex gives earlier-listed overlapping links precedence.
  for (const [client, list] of links) {
    list.sort((a, b) => a.from - b.from);
    const disjoint: Link[] = [];
    for (const link of list) {
      const from = Math.max(link.from, disjoint.at(-1)?.to ?? 0);
      if (from < link.to) disjoint.push({ ...link, from, clock: link.clock + from - link.from });
    }
    links.set(client, disjoint);
  }
  const base: ItemRange[] = record.flatMap((entry) => entry.base);
  const seen = new Set<string>();
  const depths = base.map(() => 0);
  const maxDepth = [...links.values()].reduce((sum, list) => sum + list.length, 0);
  for (let i = 0; i < base.length; i++) {
    const [client, clock, length] = base[i];
    const key = `${client}:${clock}:${length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = links.get(client);
    if (!list || depths[i] >= maxDepth) continue;
    let lo = 0,
      hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].to <= clock) lo = mid + 1;
      else hi = mid;
    }
    for (; lo < list.length && list[lo].from < clock + length; lo++) {
      const link = list[lo];
      const from = Math.max(clock, link.from);
      const end = Math.min(clock + length, link.to);
      base.push([link.client, link.clock + from - link.from, end - from]);
      depths.push(depths[i] + 1);
    }
  }
  const inserted = evidence(base);
  const deleted = evidence(record.flatMap((entry) => entry.settled));
  return parts.map((part) => inserted(part.inserted) || deleted(part.deleted));
}
