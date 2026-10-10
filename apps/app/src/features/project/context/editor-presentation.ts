/** One displayed-props decision for the mounted Editor, its boundary, and rail hand-offs. */
import type { ProjectRouteIssue } from "../routing/ProjectRouteBoundary";
import type { ScreenKey } from "../shell/screens";

export function resolveEditorPresentation<T extends { editorWorkId: string }>({
  current,
  prior,
  requestedWorkId,
  screen,
  contextLive,
  issue,
}: {
  current: T | null;
  prior: T | null;
  requestedWorkId: string | null;
  screen: ScreenKey;
  contextLive: boolean;
  issue?: ProjectRouteIssue;
}) {
  const active = screen === "context" && current !== null && contextLive && !issue;
  const mounted = active ? current : prior;
  const retainWhileLoading = prior !== null && prior.editorWorkId === requestedWorkId;
  const visible =
    screen === "context" &&
    current !== null &&
    mounted !== null &&
    (!issue || (issue === "loading" && retainWhileLoading));
  return { active, mounted, retainWhileLoading, visible };
}
