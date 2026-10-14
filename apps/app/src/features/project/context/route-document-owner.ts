/**
 * route-document-owner — the one order in which a route finds its document.
 *
 * Desktop and phone read the same sources: the live catalog and the draft-only
 * admission (the review tab a pending new-document draft installs). A document the
 * route is bound to is found by identity in both, whatever path it now holds. The
 * path occupant is consulted only when the route knows no identity, because an
 * occupant of a path the bound document left or took is some other document. When a
 * known identity resolves nowhere the answer is `pending`, never that occupant.
 */
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import type { ContextTab, ServerContextTab } from "@/client/stores";
import type { ContextRouteTarget } from "../routing/project-route";
import { resolveWorkspaceRoute } from "./context-route-workspace-owner";

export type RouteDocumentOwner =
  | { kind: "live"; file: CatalogFile; byIdentity: boolean }
  | { kind: "draft-only"; tab: ServerContextTab }
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
  locator: ContextRouteTarget;
  boundDocumentId?: string | null;
  catalog: Pick<CatalogContextView, "findDocument" | "findPath"> | null;
  /** The Editor workspace's tabs; only draft-only review tabs of the locator's Work count. */
  workspaceTabs?: readonly ContextTab[];
}): RouteDocumentOwner {
  const live = resolveLiveRouteDocument({
    path: input.locator.path,
    boundDocumentId: input.boundDocumentId,
    catalog: input.catalog,
  });
  if (live.kind === "live") return live;
  const tab = draftOnlyOwner(input);
  return tab ? { kind: "draft-only", tab } : live;
}

function draftOnlyOwner({
  locator,
  boundDocumentId,
  workspaceTabs,
}: {
  locator: ContextRouteTarget;
  boundDocumentId?: string | null;
  workspaceTabs?: readonly ContextTab[];
}): ServerContextTab | null {
  const owner = resolveWorkspaceRoute({
    tabs: (workspaceTabs ?? []).filter(
      (tab) => tab.kind !== "new" && tab.draftOnly === true && tab.reviewWorkId === locator.workId,
    ),
    selectedDocumentId: undefined,
    locator,
    boundDocumentId,
  });
  return owner.kind === "owner" && owner.tab.kind !== "new" ? owner.tab : null;
}
