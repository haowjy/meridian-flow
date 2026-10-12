/** Canonical document locators repair both live and review addresses without changing identity. */
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import {
  type CatalogFileEntry,
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
import { type ParsedRequestId, parseRequestId } from "@meridian/contracts/request-id";
import type { ProjectAddress } from "./project-address";
import { workSelectionFor } from "./project-address-resolution";

export function canonicalDocumentAddress(
  address: ProjectAddress,
  document: CatalogFileEntry,
  workId: string,
  noWorkId: string | null,
):
  | (ProjectAddress & { destination: Extract<ProjectAddress["destination"], { kind: "document" }> })
  | null {
  const uri = parseUnifiedContextUri(document.uri);
  if (!uri.ok || !isProjectContextTreeScheme(uri.value.scheme)) return null;
  const destination: ProjectAddress["destination"] = {
    kind: "document",
    scheme: uri.value.scheme,
    path: document.path.join("/"),
  };
  const scope = document.scope;
  // A chat's Scratch names its lineage; the Editor's selected Work stays implicit.
  const { lineage: _previousLineage, ...previous } = address;
  return scope.kind === "lineage"
    ? {
        ...previous,
        destination,
        work: { kind: "absent" },
        ...(parseRequestId(scope.rootThreadId)
          ? { lineage: parseRequestId(scope.rootThreadId) as ParsedRequestId }
          : {}),
      }
    : {
        ...previous,
        destination,
        work: workSelectionFor(
          destination,
          scope.kind === "work" && isWorkScopedProjectContextScheme(uri.value.scheme)
            ? scope.workId
            : workId,
          noWorkId,
        ),
      };
}

/** Hidden review tabs have no live catalog to refresh their canonical labels. */
export function canonicalReviewTabPatch(
  tab: { scheme: string; path: string; name: string },
  destination: Extract<ProjectAddress["destination"], { kind: "document" }>,
  name: string,
): { scheme: typeof destination.scheme; path: string; name: string } | null {
  const path = `/${destination.path}`;
  return tab.scheme === destination.scheme && tab.path === path && tab.name === name
    ? null
    : { scheme: destination.scheme, path, name };
}
