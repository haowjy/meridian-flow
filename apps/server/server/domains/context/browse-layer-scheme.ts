/**
 * Browse-layer helpers for project context HTTP routes.
 * Project routes use the same scheme names as the unified ContextPort.
 */
import {
  type CanonicalContextAuthority,
  contextUriFromSourceLocation,
  isOwnedContextScheme,
  type OwnedContextUriScheme,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

/** Serialize the canonical authority selected by the project browse route. */
export function projectBrowseContextUri(
  scheme: OwnedContextUriScheme,
  path: string,
  authority: CanonicalContextAuthority,
): string;
export function projectBrowseContextUri(
  scheme: Exclude<ProjectContextTreeScheme, OwnedContextUriScheme>,
  path: string,
  authority?: Extract<CanonicalContextAuthority, { kind: "contextual" }>,
): string;
export function projectBrowseContextUri(
  scheme: ProjectContextTreeScheme,
  path: string,
  authority?: CanonicalContextAuthority,
): string;
export function projectBrowseContextUri(
  scheme: ProjectContextTreeScheme,
  path: string,
  authority: CanonicalContextAuthority = { kind: "contextual" },
): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return isOwnedContextScheme(scheme)
    ? contextUriFromSourceLocation(scheme, normalized, authority)
    : contextUriFromSourceLocation(scheme, normalized);
}

export function ownedBrowseUri(
  scheme: OwnedContextUriScheme,
  authority: Exclude<CanonicalContextAuthority, { kind: "contextual" }>,
  path = "",
): string {
  return projectBrowseContextUri(scheme, path, authority);
}
