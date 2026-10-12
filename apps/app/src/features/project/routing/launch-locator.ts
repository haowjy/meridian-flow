/**
 * launch-locator — where a review launch's document is now.
 *
 * A launch carries the locator its draft row captured, which a rename, a move or a reused
 * path can have outdated. The document's identity decides, in the order the route owners read
 * it: its workspace tab (kept current by renames and moves, and only an optimization), the
 * address that names it, a draft-only document's own draft admission, the live catalog, and
 * last the server's exact identity lookup. A cached locator is never the answer by itself:
 * when identity cannot be resolved the launch fails rather than navigating to whatever
 * document holds the old path.
 */
import type { ProjectContextIdentityResolution } from "@meridian/contracts/protocol";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { projectCatalogFile } from "@/client/query/useContextCatalog";
import type { ContextTab } from "@/client/stores";
import { routeTargetForTab } from "../context/context-removal-planner";
import { canonicalDocumentPath } from "./local-document-address";
import type { ProjectDestination } from "./project-address";
import type { ContextRouteRequest } from "./project-route";

export type LaunchIdentityLookup = (
  documentId: string,
) => Promise<ProjectContextIdentityResolution | { kind: "failed" }>;

export async function resolveLaunchLocator(input: {
  requested: ContextRouteRequest & { workId?: string };
  tabs: readonly ContextTab[];
  addressed: ProjectDestination;
  addressNamesIt: boolean;
  /** The prepared review tab is a pending new-document draft: the draft list is its admission. */
  draftOnly: boolean;
  catalog: Pick<CatalogContextView, "findDocument"> | null;
  lookup: LaunchIdentityLookup;
}): Promise<ContextRouteRequest> {
  const { requested } = input;
  const { documentId } = requested;
  if (!documentId) return requested;
  const tab = input.tabs.find((candidate) => candidate.documentId === documentId);
  if (tab && tab.kind !== "new" && requested.workId) {
    return { ...routeTargetForTab(tab, requested.workId), documentId };
  }
  if (input.addressNamesIt && input.addressed.kind === "document") {
    // The address spells its path without the leading slash; routes, tabs and launches spell it with.
    return {
      ...requested,
      scheme: input.addressed.scheme,
      path: `/${canonicalDocumentPath(input.addressed.path)}`,
    };
  }
  if (input.draftOnly) return requested;
  const live = input.catalog?.findDocument(documentId);
  if (live) return { ...requested, scheme: "manuscript", path: live.path };
  const resolution = await input.lookup(documentId);
  if (resolution.kind !== "available" || !resolution.entry.uri.startsWith("manuscript://"))
    throw new Error("The reviewed document could not be located");
  return { ...requested, scheme: "manuscript", path: projectCatalogFile(resolution.entry).path };
}
