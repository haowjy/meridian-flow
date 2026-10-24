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

/**
 * The address and Work the one mounted Editor frame (path, tab strip, commands) names.
 * On the Editor screen it is where the writer is going; the retained previous document
 * stays only beneath the body mask. Off the screen the warm editor keeps its own route.
 */
export function resolveEditorFrame<T>({
  screen,
  requested,
  mounted,
}: {
  screen: ScreenKey;
  requested: T;
  mounted: T | null;
}): T | null {
  return screen === "context" ? requested : mounted;
}
