/** Exact, heuristic-free resolution of the Editor workspace owner for one committed route. */

import { type ContextTab, editorHasReview, isDraftOnly, isEditorContextTab } from "@/client/stores";
import type { ContextRouteTarget } from "../routing/project-route";
import { type ContextRouteIdentity, routeTargetForTab } from "./context-removal-planner";
import { contextTabMatchesRoute } from "./context-tab-identity";

export type WorkspaceRouteResolution =
  | { kind: "owner"; tab: ContextTab; identity: ContextRouteIdentity }
  | {
      kind: "materialized-local";
      tab: Extract<ContextTab, { kind: "tracked" }>;
      target: ContextRouteTarget;
    }
  | { kind: "unowned" };

export function resolveWorkspaceRoute({
  tabs,
  selectedDocumentId,
  locator,
  boundDocumentId,
  scope,
}: {
  tabs: readonly ContextTab[];
  selectedDocumentId: string | undefined;
  locator: ContextRouteTarget | null;
  /**
   * The document this locator is bound to. Its tab owns the route wherever the
   * tab's own path has gone, so a rename that updates the tab before the address
   * follows never leaves the route unowned for a frame.
   */
  boundDocumentId?: string | null;
  /** The Work scope: a plain path settles on a draft-only tab only if this scope reviews it. */
  scope: string | null;
}): WorkspaceRouteResolution {
  if (!locator) return { kind: "unowned" };
  tabs = tabs.filter(isEditorContextTab);
  // Identity before path (see route-document-owner): a bound document's tab owns the route
  // wherever the tab's path went, and no other tab may own it by holding the path.
  const server = boundDocumentId
    ? tabs.find((tab) => tab.kind !== "new" && tab.documentId === boundDocumentId)
    : tabs.find(
        (tab) =>
          tab.kind !== "new" &&
          contextTabMatchesRoute(tab, locator) &&
          (!isDraftOnly(tab) || editorHasReview(tab, scope)),
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
