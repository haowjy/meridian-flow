/**
 * The Write pane's tab and the route's claim on it. The pane shows the store's selected tab; the
 * address only claims a tab (`workspaceRoute`) so the route can bind and select it. An address that
 * has no tab yet shows nothing, so the pane waits for the open command instead of showing the
 * previous document under a new URL.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import { type ContextRouteSelection, routeSelectionDocumentId } from "./context-removal-protocol";
import { resolveWorkspaceRoute } from "./context-route-workspace-owner";

export type VisibleEditorRoute = {
  editorWorkId: string | null;
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
  localDocumentId,
  activeContextScheme,
  activeContextPath,
  activeContextChat,
}: VisibleEditorRoute & {
  tabs: readonly ContextTab[];
  selectedTabId?: string | null;
  selection: ContextRouteSelection;
}) {
  const selectedDocumentId = localDocumentId ?? selectedTabId ?? undefined;
  const locator =
    editorWorkId && activeContextScheme !== null && activeContextPath !== null
      ? {
          scheme: activeContextScheme,
          path: activeContextPath,
          workId: editorWorkId,
          ...(activeContextChat ? { rootThreadId: activeContextChat } : {}),
        }
      : null;
  const boundDocumentId = locator ? routeSelectionDocumentId(selection, locator) : null;
  const workspaceRoute = resolveWorkspaceRoute({
    tabs,
    selectedDocumentId,
    locator,
    boundDocumentId,
  });
  const selected = tabs.find((tab) => tab.documentId === selectedDocumentId) ?? null;
  return {
    selectedDocumentId,
    locator,
    workspaceRoute,
    // A locator with no owning tab is an open still in flight; with one, the selection
    // follows it in the same commit.
    tab: locator && workspaceRoute.kind === "unowned" ? null : selected,
  };
}
