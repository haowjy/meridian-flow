/** Desktop owns the Write pane's presentation of the selected tab and the rail's mode switch; routes own addresses. */
import { useLayoutEffect, useRef } from "react";
import { readDocumentView } from "@/client/project-shell/document-views";
import { selectedDocumentIdOf, useContextTabs, useSelectedContextTab } from "@/client/stores";
import { useAccountId, useAccountResourceProjection } from "./context/account-feature-context";
import { projectResourceTab } from "./context/context-tab-from-file";
import { resolveEditorPresentation } from "./context/editor-presentation";
import type { VisibleEditorRoute } from "./context/resolve-route-owner";
import { resolveRouteOwner } from "./context/resolve-route-owner";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import { useChatNavigation } from "./routing/chat-navigation";
import { useRailScreenSwitch } from "./routing/document-switch-failure";
import {
  useIsCurrentNavigation,
  useOpenContextRoute,
  useScreenCommands,
} from "./routing/ProjectNavigationContext";
import type { ProjectRouteIssue } from "./routing/ProjectRouteBoundary";
import { openDocumentInEditor } from "./routing/use-open-document-in-editor";
import type { ScreenKey } from "./shell/screens";

export function useDesktopProjectController<
  T extends VisibleEditorRoute & { editorWorkId: string },
>(input: {
  projectId: string;
  screen: ScreenKey;
  current: T | null;
  requestedWorkId: string | null;
  contextLive: boolean;
  issue?: ProjectRouteIssue;
}) {
  const { screen } = input;
  const editorPresentation = useDesktopEditorPresentation(input);
  const chat = useChatNavigation();
  const commands = useScreenCommands();
  const open = useOpenContextRoute();
  const isCurrent = useIsCurrentNavigation();
  const selectRailScreen = useRailScreenSwitch(screen, isCurrent);
  const selected = useSelectedContextTab(input.projectId);
  const accountId = useAccountId();
  // The selection is the one open document: a mode switch moves the view, never the document.
  const selectScreen = (next: ScreenKey) => {
    if (!commands || !open) return;
    selectRailScreen(next, () =>
      next === "chat"
        ? chat.showChatScreen()
        : selected && selected.documentId !== editorPresentation.resolved.tab?.documentId
          ? openDocumentInEditor(open, selected, {
              review: readDocumentView(accountId, input.projectId, selected.documentId).pin,
            })
          : commands.showEditor(),
    );
  };
  return { editorPresentation, selectScreen };
}

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
  const resolved = resolveRouteOwner({
    ...(presentation.mounted ?? {
      editorWorkId: null,
      activeContextScheme: null,
      activeContextPath: null,
    }),
    tabs: workspace.tabs,
    selectedTabId: selectedDocumentIdOf(workspace) ?? undefined,
    selection: removal.selection,
  });
  const resource = resolved.tab
    ? projectResourceTab(input.projectId, resolved.tab, projection.records, projection.placement)
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
