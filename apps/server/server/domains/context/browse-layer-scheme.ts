/**
 * Browse-layer helpers for project context HTTP routes.
 * Project routes use the same scheme names as the unified ContextPort.
 */
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
  type WorkAuthorityScheme,
} from "@meridian/contracts/protocol";

export const isWorkScopedBrowseScheme = isWorkScopedProjectContextScheme;

export function projectBrowseContextUri(
  scheme: ProjectContextTreeScheme,
  path: string,
  workId?: string | null,
): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (isWorkScopedBrowseScheme(scheme)) {
    return workScopedBrowseUri(scheme, workId ?? "", normalized);
  }
  return normalized ? `${scheme}://${normalized}` : `${scheme}://`;
}

export function workScopedBrowseUri(
  scheme: WorkAuthorityScheme,
  workId: string,
  path = "",
): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `${scheme}://${workId}/${normalized}` : `${scheme}://${workId}`;
}
