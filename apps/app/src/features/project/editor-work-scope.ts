/** Resolves the Editor's sole Work scope independently from persistent Chat ownership. */

import type { CatalogWorkResolution } from "./catalog-work-resolution";
import type { RouteWorkResolution } from "./routing/project-route";

export type EditorWorkScope =
  | { status: "ready"; workId: string; source: "route" | "chat" }
  | { status: "loading"; workId: string }
  | { status: "error"; workId: string }
  | { status: "empty" }
  | { status: "normalizing"; workId: string };

export function resolveEditorWorkScope(
  routeWork: RouteWorkResolution,
  chatWorkId: string | null,
  catalogWork: CatalogWorkResolution,
): EditorWorkScope {
  if (routeWork.status === "present")
    return { status: "ready", workId: routeWork.workId, source: "route" };
  if (routeWork.status === "loading") return { status: "loading", workId: routeWork.workId };
  if (routeWork.status === "catalog-error") return { status: "error", workId: routeWork.workId };
  if (routeWork.status === "malformed") return { status: "normalizing", workId: routeWork.value };
  if (routeWork.status === "not-found") return { status: "normalizing", workId: routeWork.workId };

  // Only a genuinely absent route Work may consult the selected Chat and the
  // catalog-derived scope. A thread binding is authoritative identity;
  // displaying its Work name must not be a prerequisite for Editor commands.
  if (chatWorkId) return { status: "ready", workId: chatWorkId, source: "chat" };
  if (catalogWork.status === "error") return { status: "error", workId: "" };
  if (catalogWork.status === "empty") return { status: "empty" };
  if (catalogWork.status === "ready") return { status: "empty" };
  return { status: "loading", workId: "" };
}
