/** Canonical document locators repair both live and review addresses without changing identity. */
import { draftOwnerKey } from "@meridian/contracts/branches";
import { isWorkScopedScheme, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { type CatalogFileEntry, isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ProjectAddress } from "./project-address";

export function canonicalDocumentAddress(
  address: ProjectAddress,
  document: CatalogFileEntry,
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
  // A Scratch document is addressed by its owner. A review keeps the owner the address names: it
  // owns the draft, not the document.
  const owner = address.itemKey
    ? address.owner
    : scope.kind === "lineage"
      ? draftOwnerKey({ kind: "lineage", rootThreadId: scope.rootThreadId })
      : scope.kind === "work" && isWorkScopedScheme(uri.value.scheme)
        ? draftOwnerKey({ kind: "work", workId: scope.workId })
        : undefined;
  return { ...address, destination, owner };
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
