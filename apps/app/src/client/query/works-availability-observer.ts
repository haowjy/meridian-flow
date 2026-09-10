/** Project-lifetime adapter from installed catalog authority to canonical Works acquisition. */
import type { QueryClient } from "@tanstack/react-query";
import type { CatalogCacheView } from "./context-catalog-cache";
import { isProjectContextCatalogKey, projectQueryKeys } from "./project-query-keys";
import { refreshWorksSnapshot } from "./works-projection-acquisition";

export function catalogWorkAuthorityChanged(
  previous: CatalogCacheView,
  next: CatalogCacheView,
): boolean {
  const authorities = (view: CatalogCacheView) =>
    new Map(
      [...view.entries.values()].flatMap((entry) =>
        entry.kind === "authority" && entry.authority.kind === "work"
          ? [[entry.authority.workId, `${entry.available}:${entry.entityRevision}`] as const]
          : [],
      ),
    );
  const before = authorities(previous);
  const after = authorities(next);
  if (before.size !== after.size) return true;
  return [...after].some(([workId, state]) => before.get(workId) !== state);
}

export function observeWorksAvailability(client: QueryClient, projectId: string): () => void {
  const installed = new Map<string, CatalogCacheView>();
  for (const query of client.getQueryCache().findAll()) {
    if (!isProjectContextCatalogKey(query.queryKey, projectId)) continue;
    const view = query.state.data as CatalogCacheView | undefined;
    if (view) installed.set(JSON.stringify(query.queryKey), view);
  }
  return client.getQueryCache().subscribe((event) => {
    if (!isProjectContextCatalogKey(event.query.queryKey, projectId)) return;
    const next = event.query.state.data as CatalogCacheView | undefined;
    if (!next) return;
    const key = JSON.stringify(event.query.queryKey);
    const previous = installed.get(key);
    installed.set(key, next);
    if (!previous || previous === next || !catalogWorkAuthorityChanged(previous, next)) return;
    void refreshWorksSnapshot(client, projectId).catch(() =>
      client.invalidateQueries({
        queryKey: projectQueryKeys.works(projectId),
        exact: true,
        refetchType: "none",
      }),
    );
  });
}
