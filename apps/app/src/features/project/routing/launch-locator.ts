/**
 * launch-locator — where a review launch's document is now.
 *
 * A launch carries the locator its draft row captured, which a rename, a move or a reused
 * path can have outdated. The document's identity decides, in the order the route owners read
 * it: its workspace tab (kept current by renames and moves, and only an optimization), the
 * address that names it, a draft-only document's own draft admission, and the live tree (a
 * launch carrying a review selector navigates at once with its known path). A cached locator is never the answer by itself:
 * when identity cannot be resolved the launch fails rather than navigating to whatever
 * document holds the old path.
 */
import type { OpenDocument } from "@/client/stores";
import type { TreeView } from "@/core/project-tree/tree-view";
import { parseContextUri } from "@/lib/context-uri";
import { routeTargetForTab } from "../context/context-removal-planner";
import { canonicalDocumentPath } from "./local-document-address";
import type { ProjectDestination } from "./project-address";
import { type ContextRouteRequest, contextRouteRequest } from "./project-route";

export function resolveLaunchLocator(input: {
  requested: ContextRouteRequest;
  tabs: readonly OpenDocument[];
  addressed: ProjectDestination;
  addressNamesIt: boolean;
  /** The prepared review tab is a pending new-document draft: the draft list is its admission. */
  draftOnly: boolean;
  tree: Pick<TreeView, "findDocument"> | null;
  /**
   * The launch carries a review selector (`{workId, itemKey}`): destination admission binds the
   * server's document and canonicalizes the path, so a miss here never fails the launch.
   */
  selected: boolean;
}): ContextRouteRequest {
  const { requested } = input;
  const { documentId } = requested;
  if (!documentId) return requested;
  const tab = input.tabs.find(
    (candidate) => candidate.kind !== "new" && candidate.documentId === documentId,
  );
  if (tab && tab.kind !== "new") return { ...routeTargetForTab(tab), documentId };
  if (input.addressNamesIt && input.addressed.kind === "document") {
    // The address spells its path without the leading slash; routes, tabs and launches spell it with.
    return contextRouteRequest({
      ...requested,
      scheme: input.addressed.scheme,
      path: `/${canonicalDocumentPath(input.addressed.path)}`,
    });
  }
  if (input.draftOnly) return requested;
  const locate = (uri: string) => {
    const parsed = parseContextUri(uri);
    return parsed ? { scheme: parsed.scheme, path: parsed.path } : null;
  };
  const live = input.tree?.findDocument(documentId);
  const cached = live ? locate(live.uri) : null;
  if (cached) return contextRouteRequest({ ...requested, ...cached });
  if (input.selected) return requested;
  throw new Error("The reviewed document could not be located");
}
