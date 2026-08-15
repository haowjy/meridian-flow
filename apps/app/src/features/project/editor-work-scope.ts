/** Resolves the Editor's sole Work scope independently from persistent Chat ownership. */
import type { RouteWorkResolution } from "./routing/project-route";

export type EditorWorkScope =
  | { status: "ready"; workId: string; source: "route" | "chat" | "fallback" }
  | { status: "loading"; workId: string }
  | { status: "error"; workId: string }
  | { status: "normalizing"; workId: string };

export type FallbackWorkResolution =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; workId: string | null };

export function resolveEditorWorkScope(
  routeWork: RouteWorkResolution,
  chatWorkId: string | null,
  fallbackWork: FallbackWorkResolution,
): EditorWorkScope {
  if (routeWork.status === "present")
    return { status: "ready", workId: routeWork.workId, source: "route" };
  if (routeWork.status === "loading") return { status: "loading", workId: routeWork.workId };
  if (routeWork.status === "catalog-error") return { status: "error", workId: routeWork.workId };
  if (routeWork.status === "malformed") return { status: "normalizing", workId: routeWork.value };
  if (routeWork.status === "not-found") return { status: "normalizing", workId: routeWork.workId };

  // Only a genuinely absent route Work may consult the selected Chat and the
  // temporary catalog fallback. A thread binding is authoritative identity;
  // displaying its Work name must not be a prerequisite for Editor commands.
  if (chatWorkId) return { status: "ready", workId: chatWorkId, source: "chat" };
  if (fallbackWork.status === "error") return { status: "error", workId: "" };
  if (fallbackWork.status === "ready" && fallbackWork.workId)
    return { status: "ready", workId: fallbackWork.workId, source: "fallback" };
  return { status: "loading", workId: "" };
}
