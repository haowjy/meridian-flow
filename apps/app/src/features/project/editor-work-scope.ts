/** Resolves the Editor's sole Work scope independently from persistent Chat ownership. */
import type { Work } from "@meridian/contracts/protocol";
import type { RouteWorkResolution } from "./routing/project-route";

export type EditorWorkScope =
  | { status: "ready"; workId: string; work: Work; source: "route" | "chat" | "fallback" }
  | { status: "loading"; workId: string }
  | { status: "error"; workId: string };

export function resolveEditorWorkScope(
  routeWork: RouteWorkResolution,
  chatWork: Work | null,
  fallbackWork: Work | null,
): EditorWorkScope {
  if (routeWork.status === "present")
    return { status: "ready", workId: routeWork.workId, work: routeWork.work, source: "route" };
  if (routeWork.status === "loading") return { status: "loading", workId: routeWork.workId };
  if (routeWork.status === "catalog-error") return { status: "error", workId: routeWork.workId };
  if (chatWork) return { status: "ready", workId: chatWork.id, work: chatWork, source: "chat" };
  if (fallbackWork)
    return { status: "ready", workId: fallbackWork.id, work: fallbackWork, source: "fallback" };
  return { status: "loading", workId: "" };
}
