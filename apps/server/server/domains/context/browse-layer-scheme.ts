/**
 * Browse-layer helpers for project context HTTP routes.
 * Project routes use the same scheme names as the unified ContextPort.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

export const WORK_SCOPED_BROWSE_SCHEMES = new Set<ProjectContextTreeScheme>(["scratch", "uploads"]);

export function projectBrowseContextUri(
  scheme: ProjectContextTreeScheme,
  path: string,
  workId?: string | null,
): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (WORK_SCOPED_BROWSE_SCHEMES.has(scheme)) {
    return workScopedBrowseUri(scheme as "scratch" | "uploads", workId ?? "", normalized);
  }
  return normalized ? `${scheme}://${normalized}` : `${scheme}://`;
}

export function workScopedBrowseUri(
  scheme: "scratch" | "uploads",
  workId: string,
  path = "",
): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `${scheme}://${workId}/${normalized}` : `${scheme}://${workId}`;
}
