/** Exact, heuristic-free resolution of the Editor workspace owner for one committed route. */

import { isEditorOpenDocument, type OpenDocument } from "@/client/stores";
import type { ContextRouteRequest } from "../routing/project-route";
import { type ContextRouteIdentity, routeTargetForTab } from "./context-removal-planner";
import { openDocumentMatchesRoute } from "./open-document-identity";

export type WorkspaceRouteResolution =
  | { kind: "owner"; tab: OpenDocument; identity: ContextRouteIdentity }
  | {
      kind: "materialized-local";
      tab: Extract<OpenDocument, { kind: "tracked" }>;
      target: ContextRouteRequest;
    }
  | { kind: "unowned" };

export function resolveWorkspaceRoute({
  tabs,
  selectedDocumentId,
  locator,
  boundDocumentId,
  isDraftOnly,
}: {
  tabs: readonly OpenDocument[];
  selectedDocumentId: string | undefined;
  locator: ContextRouteRequest | null;
  /**
   * The document this locator is bound to. Its tab owns the route wherever the
   * tab's own path has gone, so a rename that updates the tab before the address
   * follows never leaves the route unowned for a frame.
   */
  boundDocumentId?: string | null;
  /**
   * A document live lacks, presented through its draft. A plain path never settles on one: a
   * draft-created page is reached only by an address that names its draft.
   */
  isDraftOnly?: (documentId: string) => boolean;
}): WorkspaceRouteResolution {
  if (!locator) return { kind: "unowned" };
  tabs = tabs.filter(isEditorOpenDocument);
  // Identity before path (see route-document-owner): a bound document's tab owns the route
  // wherever the tab's path went, and no other tab may own it by holding the path.
  const server = boundDocumentId
    ? tabs.find((tab) => tab.kind !== "new" && tab.documentId === boundDocumentId)
    : tabs.find(
        (tab) =>
          tab.kind !== "new" &&
          openDocumentMatchesRoute(tab, locator) &&
          !isDraftOnly?.(tab.documentId),
      );
  if (server) {
    return {
      kind: "owner",
      tab: server,
      identity: { kind: "server", documentId: server.documentId },
    };
  }
  if (locator.scheme !== "unfiled" || locator.path !== "" || !selectedDocumentId) {
    return { kind: "unowned" };
  }
  const selected = tabs.find((tab) => tab.documentId === selectedDocumentId);
  if (selected?.kind === "new") {
    return {
      kind: "owner",
      tab: selected,
      identity: { kind: "local", documentId: selected.documentId },
    };
  }
  if (selected?.kind === "tracked" && selected.origin === "local-resource") {
    return { kind: "materialized-local", tab: selected, target: routeTargetForTab(selected) };
  }
  return { kind: "unowned" };
}
