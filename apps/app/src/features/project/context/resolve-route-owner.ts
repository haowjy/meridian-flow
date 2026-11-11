/**
 * The Write pane's tab and the route's claim on it. The pane shows the store's selected tab; the
 * address only claims a tab (`workspaceRoute`) so the route can bind and select it. An address that
 * has no tab yet shows nothing, so the pane waits for the open command instead of showing the
 * previous document under a new URL.
 */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import { contextRouteRequest } from "../routing/project-route";
import { type ContextRouteSelection, routeSelectionDocumentId } from "./context-removal-protocol";
import { resolveWorkspaceRoute } from "./context-route-workspace-owner";

export type VisibleEditorRoute = {
  /** The Work scope. */
  editorWorkId: string | null;
  /** A Work's Scratch route: its owning Work. Null for every other document. */
  activeContextWork?: string | null;
  localDocumentId?: string | null;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  activeContextChat?: string | null;
};

export function resolveRouteOwner({
  tabs,
  selectedTabId,
  selection,
  editorWorkId,
  activeContextWork,
  localDocumentId,
  activeContextScheme,
  activeContextPath,
  activeContextChat,
  isDraftOnly,
}: VisibleEditorRoute & {
  tabs: readonly ContextTab[];
  selectedTabId?: string | null;
  selection: ContextRouteSelection;
  isDraftOnly: (documentId: string) => boolean;
}) {
  const selectedDocumentId = localDocumentId ?? selectedTabId ?? undefined;
  const locator =
    editorWorkId && activeContextScheme !== null && activeContextPath !== null
      ? contextRouteRequest({
          scheme: activeContextScheme,
          path: activeContextPath,
          workId: activeContextWork,
          rootThreadId: activeContextChat,
        })
      : null;
  const boundDocumentId = locator ? routeSelectionDocumentId(selection, locator) : null;
  const workspaceRoute = resolveWorkspaceRoute({
    tabs,
    selectedDocumentId,
    locator,
    boundDocumentId,
    isDraftOnly,
  });
  const selected = tabs.find((tab) => tab.documentId === selectedDocumentId) ?? null;
  return {
    selectedDocumentId,
    locator,
    workspaceRoute,
    // A locator with no owning tab is an open still in flight; with one, the selection
    // follows it in the same commit. No locator is the bare Editor (the recents chooser):
    // the store keeps its selected tab, the pane shows none. A local draft is not that
    // case: it publishes an `unfiled` locator.
    tab: locator && workspaceRoute.kind !== "unowned" ? selected : null,
  };
}
