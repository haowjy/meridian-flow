import type { CommandDriver, CommandRecord } from "@meridian/command-driver";
import { matchQuery, type QueryClient, type QueryFilters } from "@tanstack/react-query";

type ReadFilters = Pick<QueryFilters, "queryKey" | "exact">;

/**
 * Settles once every query `filters` match that is on screen has been read from the server since
 * now, so a read that failed keeps waiting until one succeeds. A command observed only then keeps
 * its projection over the list until the list has it. `loaded`: a read already held counts.
 * `cached`: every cached query a refetch would read counts, not only those on screen.
 * Call it before starting the reads, so their answers are seen.
 */
export function whenRead(
  client: QueryClient,
  filters: ReadFilters,
  { loaded = false, cached = false }: { loaded?: boolean; cached?: boolean } = {},
) {
  const cache = client.getQueryCache();
  const shown = () =>
    cached
      ? cache.findAll(filters).filter((query) => !query.isDisabled() && !query.isStatic())
      : cache.findAll({ ...filters, type: "active" });
  const waiting = new Set(shown().filter((query) => !loaded || query.state.status !== "success"));
  return new Promise<void>((resolve) => {
    const done = () => {
      const active = new Set(shown());
      for (const query of waiting) if (!active.has(query)) waiting.delete(query);
      if (waiting.size > 0) return false;
      resolve();
      return true;
    };
    if (done()) return;
    const stop = cache.subscribe((event) => {
      if (!matchQuery(filters, event.query)) return;
      // `manual`: a write of this browser's own (`setQueryData`), not a read.
      if (event.type === "updated" && event.action.type === "success" && !event.action.manual)
        waiting.delete(event.query);
      if (done()) stop();
    });
  });
}

export function rereadThenObserve(
  client: QueryClient,
  driver: CommandDriver | null | undefined,
  settled: (record: CommandRecord) => boolean,
  reads: readonly ReadFilters[],
): void {
  const read = Promise.all(reads.map((filters) => whenRead(client, filters, { cached: true })));
  // Not invalidateQueries: it rereads only mounted copies, and an unmounted one would open on the
  // old value once the projection is observed away.
  for (const filters of reads) void client.refetchQueries(filters);
  void read.then(() => driver?.observe(settled));
}
