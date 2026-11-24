import { matchQuery, type QueryClient, type QueryFilters } from "@tanstack/react-query";

/**
 * Settles once every query `filters` match that is on screen has been read from the server since
 * now, so a read that failed keeps waiting until one succeeds. A command observed only then keeps
 * its projection over the list until the list has it. `loaded`: a read already held counts.
 * Call it before starting the reads, so their answers are seen.
 */
export function whenRead(
  client: QueryClient,
  filters: Pick<QueryFilters, "queryKey" | "exact">,
  loaded = false,
) {
  const cache = client.getQueryCache();
  const shown = () => cache.findAll({ ...filters, type: "active" });
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
