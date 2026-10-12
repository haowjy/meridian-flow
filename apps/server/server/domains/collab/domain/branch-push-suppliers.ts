/** Finds causal transport without making historical suppliers selectable or authored. */
import {
  decodeUpdateForDependencies,
  deleteRanges,
  rangeCovers,
  rangesOverlap,
  structDependencies,
  suppliedRanges,
} from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import type { BranchJournalRow } from "./branch-push-contracts.js";

export function transportSuppliers(
  live: Y.Doc,
  history: readonly BranchJournalRow[],
  selected: readonly BranchJournalRow[],
): BranchJournalRow[] {
  const state = Y.decodeStateVector(Y.encodeStateVector(live));
  const own = new Set(selected.map((row) => row.id));
  const carried = new Set<number>();
  const decoded = history.map((row) => {
    const update = decodeUpdateForDependencies(row.updateData);
    return {
      row,
      supplied: suppliedRanges(update),
      references: [...deleteRanges(update), ...structDependencies(update)],
    };
  });
  const liveDeleted = deleteRanges(decodeUpdateForDependencies(Y.encodeStateAsUpdate(live)));
  const inLive = (row: BranchJournalRow) => {
    const entry = decoded.find((entry) => entry.row.id === row.id);
    if (!entry) throw new Error("Supplier missing from retained generation history");
    return (
      entry.supplied.every(
        (range) => (state.get(range.client) ?? 0) >= range.clock + range.length,
      ) &&
      deleteRanges(decodeUpdateForDependencies(row.updateData)).every((range) =>
        liveDeleted.some((existing) => rangeCovers(existing, range)),
      )
    );
  };
  const queue = [...selected];
  const add = (row: BranchJournalRow) => {
    if (own.has(row.id) || carried.has(row.id) || inLive(row)) return;
    carried.add(row.id);
    queue.push(row);
  };
  for (let i = 0; i < queue.length; i++) {
    const current = decoded.find((entry) => entry.row.id === queue[i].id);
    if (!current) throw new Error("Selected row missing from retained generation history");
    // A later same-client range also needs every missing prefix, even without an Item reference.
    const required = [
      ...current.references,
      ...current.supplied.map((range) => ({ ...range, clock: 0, length: range.clock })),
    ];
    for (const ref of required) {
      const clock = Math.max(ref.clock, state.get(ref.client) ?? 0);
      const length = ref.clock + ref.length - clock;
      if (length <= 0) continue;
      for (const supplier of decoded) {
        if (supplier.row.id >= current.row.id) continue;
        if (supplier.supplied.some((range) => rangesOverlap(range, { ...ref, clock, length })))
          add(supplier.row);
      }
    }
    const metadata = current.row.updateMeta as {
      kind?: string;
      discardedJournalIds?: number[];
    } | null;
    if (metadata?.kind === "discard") {
      for (const id of metadata.discardedJournalIds ?? []) {
        const cancelled = history.find((row) => row.id === id);
        if (!cancelled)
          throw new Error(`Restoration supplier ${current.row.id} lost its cancelled row ${id}`);
        add(cancelled);
      }
    }
    if (current.row.status === "discarded") {
      const cancellations = history.filter(
        (row) =>
          (row.updateMeta as { kind?: string } | null)?.kind === "discard" &&
          (
            (row.updateMeta as { discardedJournalIds?: number[] }).discardedJournalIds as
              | number[]
              | undefined
          )?.includes(current.row.id),
      );
      if (!cancellations.length)
        throw new Error(`Discarded supplier ${current.row.id} has no retained cancellation`);
      for (const row of cancellations) add(row);
    }
  }
  return history.filter((row) => carried.has(row.id));
}
