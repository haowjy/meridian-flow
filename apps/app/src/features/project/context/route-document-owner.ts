/**
 * route-document-owner — the one order in which a route finds its document.
 *
 * Desktop and phone read the same sources: the live catalog, and the draft row the address
 * names with its `owner` and `item` (a page a draft created is hidden from the catalog until
 * Apply, so its draft row is its only descriptor). A document the route is bound to is found by
 * identity in both, whatever path it now holds. The path occupant is consulted only when the
 * route knows no identity, because an occupant of a path the bound document left or took is
 * some other document. When a known identity resolves nowhere the answer is `pending`, never
 * that occupant.
 */
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import type { OpenDocument } from "@/client/stores";
import type { ContextRouteRequest } from "../routing/project-route";

/** The document an answered address names (`addressedDocument`). */
export type AddressedDocument = { tab: OpenDocument; draftOnly: boolean };

export type RouteDocumentOwner =
  | { kind: "live"; file: CatalogFile; byIdentity: boolean }
  /** Live lacks the document: its descriptor is the address's draft row. */
  | { kind: "draft-only"; tab: OpenDocument }
  /** The bound document the catalog lacks here (a review of a move): the address's answer. */
  | { kind: "addressed"; tab: OpenDocument }
  /** An identity the route holds that no source resolves yet. */
  | { kind: "pending" }
  | { kind: "absent" };
/**
 * The live half of the order: the bound identity wherever its path went, else (only with no
 * bound identity) the path's occupant. A bound identity the catalog lacks is `pending`.
 */
export function resolveLiveRouteDocument(input: {
  path: string;
  boundDocumentId?: string | null;
  catalog: Pick<CatalogContextView, "findDocument" | "findPath"> | null;
}):
  | { kind: "live"; file: CatalogFile; byIdentity: boolean }
  | { kind: "pending" }
  | { kind: "absent" } {
  if (input.boundDocumentId) {
    const live = input.catalog?.findDocument(input.boundDocumentId);
    return live ? { kind: "live", file: live, byIdentity: true } : { kind: "pending" };
  }
  const occupant = input.catalog?.findPath(input.path);
  return occupant?.kind === "file"
    ? { kind: "live", file: occupant, byIdentity: false }
    : { kind: "absent" };
}

export function resolveRouteDocumentOwner(input: {
  locator: ContextRouteRequest;
  boundDocumentId?: string | null;
  catalog: Pick<CatalogContextView, "findDocument" | "findPath"> | null;
  addressed?: AddressedDocument | null;
}): RouteDocumentOwner {
  const live = resolveLiveRouteDocument({
    path: input.locator.path,
    boundDocumentId: input.boundDocumentId,
    catalog: input.catalog,
  });
  if (live.kind === "live") return live;
  const addressed = input.addressed;
  if (!addressed || (input.boundDocumentId && addressed.tab.documentId !== input.boundDocumentId))
    return live;
  if (addressed.draftOnly) return { kind: "draft-only", tab: addressed.tab };
  return live.kind === "pending" ? { kind: "addressed", tab: addressed.tab } : live;
}
