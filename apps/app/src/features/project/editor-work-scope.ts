/** Converts an already-resolved readable Editor selection into content authority. */
import type { RouteWorkResolution } from "./routing/project-route";
export type EditorWorkScope =
  | { status: "ready"; workId: string | null; source: "route" }
  | { status: "loading" | "error" | "unavailable"; workId: string };
export function resolveEditorWorkScope(routeWork: RouteWorkResolution): EditorWorkScope {
  if (routeWork.status === "unresolved")
    return { status: routeWork.reason, workId: routeWork.slug };
  if (routeWork.status === "none") return { status: "ready", workId: null, source: "route" };
  if (routeWork.work.status === "archived")
    return { status: "unavailable", workId: routeWork.workId };
  return { status: "ready", workId: routeWork.workId, source: "route" };
}
