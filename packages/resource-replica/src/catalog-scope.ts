/** Catalog scope identity for one project's installed resource projection. */
import { type CatalogScope, catalogScopeKey } from "@meridian/contracts/protocol";

/** User catalogs are account-owned but installed separately for each consuming project. */
export function catalogProjectionKey(projectId: string, scope: CatalogScope): string {
  return JSON.stringify([projectId, scope.kind === "user" ? "user" : catalogScopeKey(scope)]);
}

/** Request `user:self` and its authenticated response name the same projection. */
export function sameCatalogProjectionScope(left: CatalogScope, right: CatalogScope): boolean {
  return left.kind === "user" && right.kind === "user"
    ? true
    : catalogScopeKey(left) === catalogScopeKey(right);
}

export function sameCatalogScope(left: CatalogScope, right: CatalogScope): boolean {
  return catalogScopeKey(left) === catalogScopeKey(right);
}

export function catalogScopeBelongsToProject(projectId: string, scope: CatalogScope): boolean {
  return scope.kind === "user" || scope.projectId === projectId;
}

export function catalogRequestBelongsToProject(projectId: string, scope: CatalogScope): boolean {
  return (
    catalogScopeBelongsToProject(projectId, scope) &&
    (scope.kind !== "user" || scope.userId === "self")
  );
}

/** A transport response must prove the exact requested authority. */
export function catalogResponseMatchesRequest(
  accountId: string,
  requested: CatalogScope,
  received: CatalogScope,
): boolean {
  if (requested.kind === "user") return received.kind === "user" && received.userId === accountId;
  return catalogScopeKey(requested) === catalogScopeKey(received);
}
