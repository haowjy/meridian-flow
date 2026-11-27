import {
  type CanonicalContextAuthority,
  canonicalContextUri,
  isOwnedContextScheme,
  type OwnedContextUriScheme,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

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
    ? canonicalContextUri(scheme, normalized, authority)
    : canonicalContextUri(scheme, normalized);
}
