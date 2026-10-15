/**
 * launch-locator — where a review launch's document is now.
 *
 * A launch carries the locator its draft row captured, which a rename, a move or a reused
 * path can have outdated. The document's identity decides, in the order the route owners read
 * it: its workspace tab (kept current by renames and moves, and only an optimization), the
 * address that names it, a draft-only document's own draft admission, the live catalog, and
 * last the server's exact identity lookup (not for a launch carrying a review selector, which
 * navigates at once with its known path). A cached locator is never the answer by itself:
 * when identity cannot be resolved the launch fails rather than navigating to whatever
 * document holds the old path.
 */
import type { ProjectContextIdentityResolution } from "@meridian/contracts/protocol";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import type { ContextTab } from "@/client/stores";
import { isDraftOnly, reviewEntryOf } from "@/client/stores";
import { parseContextUri } from "@/lib/context-uri";
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
  /**
   * The launch carries a review selector (`{workId, itemKey}`): destination admission binds the
   * server's document and canonicalizes the path, so a miss here never waits on, or fails by, a
   * live-identity lookup.
   */
  selected: boolean;
  lookup: LaunchIdentityLookup;
}): Promise<ContextRouteRequest> {
  const { requested } = input;
  const { documentId } = requested;
  if (!documentId) return requested;
  const tab = input.tabs.find(
    (candidate) =>
      candidate.kind !== "new" &&
      candidate.documentId === documentId &&
      (!isDraftOnly(candidate) ||
        Boolean(requested.workId && reviewEntryOf(candidate, requested.workId))),
  );
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
  const locate = (uri: string): ContextRouteRequest | null => {
    const parsed = parseContextUri(uri);
    return parsed ? { scheme: parsed.scheme, path: parsed.path } : null;
  };
  const live = input.catalog?.findDocument(documentId);
  const cached = live ? locate(live.uri) : null;
  if (cached) return { ...requested, ...cached };
  if (input.selected) return requested;
  const resolution = await input.lookup(documentId);
  const location = resolution.kind === "available" ? locate(resolution.entry.uri) : null;
  if (!location) throw new Error("The reviewed document could not be located");
  return { ...requested, ...location };
}
