/** The route-side adapter for Editor address repairs: turns a settled search update into a navigation. */
import type { OpenContextRoute } from "./ProjectNavigationContext";
import { type ProjectSearch, projectSearchEquals } from "./project-route";

export function applyContextRemovalSearchUpdate({
  search,
  update,
  relocated,
  openContext,
  goWorks,
  goEditor,
}: {
  search: ProjectSearch;
  update: (latest: ProjectSearch) => ProjectSearch;
  /** The document a relocation moves; absent for a replacement or fallback. */
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
      // The review selector is not passed: the command keeps it only when the address names
      // the same document, which a relocation's identity proves across a rename. A fallback
      // document opens without one, however the draft list reads.
      { replace: true, documentId: relocated?.documentId },
    );
  else if (next.screen === "work") goWorks();
  else if (next.screen === "context") goEditor();
}
