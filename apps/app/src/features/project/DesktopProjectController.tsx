/** Desktop owns the Write pane's presentation of the selected tab; routes own addresses. */
import { useLayoutEffect, useRef } from "react";
import { selectedDocumentIdOf, useContextTabs } from "@/client/stores";
import { useAccountResourceProjection } from "./context/account-feature-context";
import { projectResourceTab } from "./context/context-tab-from-file";
import { resolveEditorPresentation } from "./context/editor-presentation";
import type { VisibleEditorRoute } from "./context/resolve-route-owner";
import { resolveRouteOwner } from "./context/resolve-route-owner";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import { useIsDraftOnly } from "./context/use-draft-only-presentation";
import type { ProjectRouteIssue } from "./routing/ProjectRouteBoundary";
import type { ScreenKey } from "./routing/project-route";

/** What the Write pane shows: the selected tab, as the resource projection now places it. */
export function useDesktopEditorPresentation<
  T extends VisibleEditorRoute & { editorWorkId: string },
>(input: {
  projectId: string;
  current: T | null;
  requestedWorkId: string | null;
  screen: ScreenKey;
  contextLive: boolean;
  issue?: ProjectRouteIssue;
}) {
  const prior = useRef<T | null>(null);
  const presentation = resolveEditorPresentation({ ...input, prior: prior.current });
  useLayoutEffect(() => {
    if (presentation.active) prior.current = input.current;
  });
  const workspace = useContextTabs(input.projectId);
  const removal = useContextRemovalProject(input.projectId);
  const projection = useAccountResourceProjection(input.projectId);
  const isDraftOnly = useIsDraftOnly(input.projectId);
  const resolved = resolveRouteOwner({
    ...(presentation.mounted ?? {
      editorWorkId: null,
      activeContextScheme: null,
      activeContextPath: null,
    }),
    tabs: workspace.tabs,
    selectedTabId: selectedDocumentIdOf(workspace) ?? undefined,
    selection: removal.selection,
    isDraftOnly,
  });
  const resource = resolved.tab
    ? projectResourceTab(
        input.projectId,
        resolved.tab,
        projection.records,
        projection.placement,
        isDraftOnly(resolved.tab.documentId),
      )
    : null;
  const tab =
    resource?.kind === "removed" || resource?.kind === "terminal"
      ? null
      : resource?.kind === "projected"
        ? resource.tab
        : resolved.tab;
  return {
    ...presentation,
    resolved: { ...resolved, tab },
    visibleTab: presentation.visible ? tab : null,
  };
}
