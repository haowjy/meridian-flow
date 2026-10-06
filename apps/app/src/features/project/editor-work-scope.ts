/** Converts an already-resolved readable Editor selection into content authority. */
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import type { RouteWorkResolution } from "./routing/project-route";
export type EditorWorkScope =
  | { status: "ready"; workId: ParsedRequestId; source: "route" }
  | { status: "loading" | "error" | "unavailable"; workId: ParsedRequestId | null };
export function resolveEditorWorkScope(
  routeWork: Exclude<RouteWorkResolution, { status: "new" | "absent" }>,
): EditorWorkScope {
  if (routeWork.status === "unresolved")
    return { status: routeWork.reason, workId: routeWork.workId };
  if (routeWork.status === "creating") return { status: "loading", workId: routeWork.workId };
  return { status: "ready", workId: routeWork.workId, source: "route" };
}
