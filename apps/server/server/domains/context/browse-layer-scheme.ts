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

/** Project browse routes bind `workId` while resolving their port, so their URI stays unqualified. */
export function projectBrowseContextUri(
  scheme: ProjectContextTreeScheme,
  path: string,
  _workId?: string | null,
): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `${scheme}://${normalized}` : `${scheme}://`;
}

export function workScopedBrowseUri(
  scheme: WorkAuthorityScheme,
  _workId: string,
  path = "",
): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `${scheme}://${normalized}` : `${scheme}://`;
}
