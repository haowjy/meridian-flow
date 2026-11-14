/**
 * route-document-owner — the one order in which a route finds its document.
 *
 * Desktop and phone read the same sources: the live tree, and the draft row the address
 * names with its `owner` and `item` (a page a draft created is hidden from the catalog until
 * Apply, so its draft row is its only descriptor). A document the route is bound to is found by
 * identity in both, whatever path it now holds. The path occupant is consulted only when the
 * route knows no identity, because an occupant of a path the bound document left or took is
 * some other document. When a known identity resolves nowhere the answer is `pending`, never
 * that occupant.
 */

import type { OpenDocument } from "@/client/stores";
import type { TreeFile, TreeView } from "@/core/project-tree/tree-view";
import type { ContextRouteRequest } from "../routing/project-route";

/** The document an answered address names (`addressedDocument`). */
export type AddressedDocument = { document: OpenDocument; draftOnly: boolean };

export type RouteDocumentOwner =
  | { kind: "live"; file: TreeFile; byIdentity: boolean }
  /** Live lacks the document: its descriptor is the address's draft row. */
  | { kind: "draft-only"; document: OpenDocument }
  /** The bound document the tree lacks here (a review of a move): the address's answer. */
  | { kind: "addressed"; document: OpenDocument }
  /** An identity the route holds that no source resolves yet. */
  | { kind: "pending" }
  | { kind: "absent" };
/**
 * The live half of the order: the bound identity wherever its path went, else (only with no
 * bound identity) the path's occupant. A bound identity the tree lacks is `pending`.
 */
export function resolveLiveRouteDocument(input: {
  path: string;
  boundDocumentId?: string | null;
  tree: Pick<TreeView, "findDocument" | "findPath"> | null;
}):
  | { kind: "live"; file: TreeFile; byIdentity: boolean }
  | { kind: "pending" }
  | { kind: "absent" } {
  if (input.boundDocumentId) {
    const live = input.tree?.findDocument(input.boundDocumentId);
    return live ? { kind: "live", file: live, byIdentity: true } : { kind: "pending" };
  }
  const occupant = input.tree?.findPath(input.path);
  return occupant?.kind === "file"
    ? { kind: "live", file: occupant, byIdentity: false }
    : { kind: "absent" };
}

export function resolveRouteDocumentOwner(input: {
  locator: ContextRouteRequest;
  boundDocumentId?: string | null;
  tree: Pick<TreeView, "findDocument" | "findPath"> | null;
  addressed?: AddressedDocument | null;
}): RouteDocumentOwner {
  const live = resolveLiveRouteDocument({
    path: input.locator.path,
    boundDocumentId: input.boundDocumentId,
    tree: input.tree,
  });
  if (live.kind === "live") return live;
  const addressed = input.addressed;
  if (
    !addressed ||
    (input.boundDocumentId && addressed.document.documentId !== input.boundDocumentId)
  )
    return live;
  if (addressed.draftOnly) return { kind: "draft-only", document: addressed.document };
  return live.kind === "pending" ? { kind: "addressed", document: addressed.document } : live;
}
