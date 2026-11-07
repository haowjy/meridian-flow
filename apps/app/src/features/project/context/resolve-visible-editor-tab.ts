/** The workspace tab rendered by an Editor pane, from its route props and removal binding. */
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

export function resolveVisibleEditorTab({
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
  return {
    selectedDocumentId,
    locator,
    workspaceRoute,
    tab: workspaceRoute.kind === "unowned" ? null : workspaceRoute.tab,
  };
}
