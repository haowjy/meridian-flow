/** The route-side adapter for Editor address updates (a renamed or moved document, a materialized Untitled): turns a settled search update into a navigation. */
import type { OpenContextRoute } from "./ProjectNavigationContext";
import { type ProjectSearch, projectSearchEquals } from "./project-route";

export function applyContextRemovalSearchUpdate({
  search,
  update,
  relocated,
  openContext,
}: {
  search: ProjectSearch;
  update: (latest: ProjectSearch) => ProjectSearch;
  /** Set when the update moves the route's own bound document to a new locator. */
  relocated: { documentId: string } | undefined;
  openContext: OpenContextRoute;
}): void {
  const next = update(search);
  if (projectSearchEquals(next, search)) return;
  if (next.scheme && next.path !== undefined)
    void openContext(
      {
        scheme: next.scheme,
        path: next.path,
        workId: next.work,
        rootThreadId: next.chat,
        ...(relocated ? { documentId: relocated.documentId } : {}),
      },
      { replace: true },
    );
}
