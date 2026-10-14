/** The route-side adapter for Editor address repairs: turns a settled search update into a navigation. */
import type { OpenContextRoute } from "./ProjectNavigationContext";
import { type ProjectSearch, projectSearchEquals } from "./project-route";

export function applyContextRemovalSearchUpdate({
  search,
  update,
  itemKey,
  relocated,
  openContext,
  goWorks,
  goEditor,
}: {
  search: ProjectSearch;
  update: (latest: ProjectSearch) => ProjectSearch;
  /** The review item the current address carries. */
  itemKey: string | undefined;
  /** Set when the planner moved the route's own bound document; absent for a fallback to another. */
  relocated: { documentId: string } | undefined;
  openContext: OpenContextRoute;
  goWorks: () => void;
  goEditor: () => void;
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
      },
      // A relocation keeps the review the address carries, until ReviewAddressOwner (which knows
      // the document's identity) decides it no longer applies. A fallback opens another document,
      // so this address's item names nothing there; the command gives a draft-only tab its own.
      { replace: true, itemKey: relocated ? itemKey : undefined },
    );
  else if (next.screen === "work") goWorks();
  else if (next.screen === "context") goEditor();
}
