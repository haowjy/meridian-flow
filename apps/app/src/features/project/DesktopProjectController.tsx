/** Desktop owns displayed documents and their deliberate rail/header transfer; routes own addresses. */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type { ContextTab } from "@/client/stores";
import { useContextTabs } from "@/client/stores";
import { useAccountResourceProjection } from "./context/account-feature-context";
import { projectResourceTab } from "./context/context-tab-from-file";
import { resolveEditorPresentation } from "./context/editor-presentation";
import type { VisibleEditorRoute } from "./context/resolve-visible-editor-tab";
import { resolveVisibleEditorTab } from "./context/resolve-visible-editor-tab";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import { type DockDocument, useDockView, useDockViewStore } from "./dock/dock-view-store";
import { handOffVisibleDocument } from "./dock/hand-off-visible-document";
import { commitDockDocument } from "./dock/use-dock-placement";
import { useProjectSurfacePrefsStore } from "./layout/surface-prefs-store";
import { useChatNavigation } from "./routing/chat-navigation";
import { railFailure, useDocumentSwitchFailures } from "./routing/document-switch-failure";
import {
  useIsCurrentNavigation,
  useOpenContextRoute,
  useScreenCommands,
} from "./routing/ProjectNavigationContext";
import type { ProjectRouteIssue } from "./routing/ProjectRouteBoundary";
import type { NavigationSettlement } from "./routing/project-navigation";
import { openDocumentInEditor } from "./routing/use-open-document-in-editor";
import type { ScreenKey } from "./shell/screens";

const DesktopPresentation = createContext<{
  screen: ScreenKey;
  document: DockDocument | null;
  openDockInEditor: (tab: ContextTab) => void;
  railSwitchFailed: ScreenKey | null;
} | null>(null);
export function useDockEditorJump() {
  return useContext(DesktopPresentation)?.openDockInEditor;
}
export function useDesktopProjectController<
  T extends VisibleEditorRoute & { editorWorkId: string },
>(input: {
  projectId: string;
  screen: ScreenKey;
  entryKey: string;
  current: T | null;
  requestedWorkId: string | null;
  contextLive: boolean;
  issue?: ProjectRouteIssue;
}) {
  const { projectId, screen, entryKey } = input;
  const editorPresentation = useDesktopEditorPresentation(input);
  const dockDocument = useDesktopDockPresentation(projectId, screen);
  const collapsed = useProjectSurfacePrefsStore((state) => state.slotPrefs.dock.collapsed);
  const editorTab = editorPresentation.visibleTab;
  const dockTab = collapsed ? null : (dockDocument?.tab ?? null);
  const chat = useChatNavigation();
  const commands = useScreenCommands();
  const open = useOpenContextRoute();
  const isCurrent = useIsCurrentNavigation();
  const failure = useDocumentSwitchFailures();
  const transfer = (source: ScreenKey, destination: ScreenKey, tab: ContextTab | null) => {
    const store = useDockViewStore.getState();
    return handOffVisibleDocument({
      source,
      destination,
      tab,
      claim: store.claim,
      isCurrent: store.isCurrent,
      transfer: (to, document, claim) => {
        if (to === "chat") commitDockDocument(projectId, "chat", document, chat.revealDock, claim);
        else store.closeDocument();
      },
    });
  };
  const present = async (
    operation: Promise<NavigationSettlement>,
    source: Parameters<typeof failure.report>[1],
  ) => {
    const result = await operation;
    if (result.kind === "failed" && isCurrent?.(result.ticket)) failure.report(result, source);
  };
  const selectScreen = (next: ScreenKey) => {
    if (!commands || !open || (screen === next && next !== "chat")) return;
    failure.clear("rail");
    const plan = transfer(screen, next, screen === "context" ? editorTab : dockTab);
    const options = plan ? { afterCommit: plan.afterCommit } : undefined;
    const operation =
      next === "chat"
        ? chat.showChatScreen(options)
        : next === "work"
          ? commands.showWork()
          : plan
            ? openDocumentInEditor(open, plan.tab, options)
            : commands.showEditor();
    void present(operation, { kind: "rail", screen: next });
  };
  const openDockInEditor = (tab: ContextTab) => {
    if (!open) return;
    failure.clear("header");
    const plan = transfer(screen, "context", tab);
    if (!plan) return;
    const claim = useDockViewStore.getState().revision;
    void present(openDocumentInEditor(open, tab, { afterCommit: plan.afterCommit }), {
      kind: "header",
      claim,
    });
  };
  return {
    editorPresentation,
    dockDocument,
    selectScreen,
    openDockInEditor,
    railSwitchFailed: railFailure(failure.failures, entryKey),
  };
}
export function DesktopProjectPresentationProvider({
  children,
  screen,
  dockDocument,
  openDockInEditor,
  railSwitchFailed,
}: {
  children: ReactNode;
  screen: ScreenKey;
  dockDocument: DockDocument | null;
  openDockInEditor: (tab: ContextTab) => void;
  railSwitchFailed: ScreenKey | null;
}) {
  return (
    <DesktopPresentation.Provider
      value={{ screen, document: dockDocument, openDockInEditor, railSwitchFailed }}
    >
      {children}
    </DesktopPresentation.Provider>
  );
}
export function useRailSwitchFailed() {
  return useContext(DesktopPresentation)?.railSwitchFailed ?? null;
}

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
  const resolved = resolveVisibleEditorTab({
    ...(presentation.mounted ?? {
      editorWorkId: null,
      activeContextScheme: null,
      activeContextPath: null,
    }),
    tabs: workspace.tabs,
    selectedTabId: workspace.selectedTabIdByWork[presentation.mounted?.editorWorkId ?? ""],
    selection: removal.selection,
  });
  const resource = resolved.tab
    ? projectResourceTab(input.projectId, resolved.tab, projection.records, projection.folders)
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
export function useDesktopDockPresentation(projectId: string, screen: ScreenKey) {
  const { document } = useDockView(screen, projectId);
  const { records, folders } = useAccountResourceProjection(projectId);
  const projected = document ? projectResourceTab(projectId, document.tab, records, folders) : null;
  const gone = projected?.kind === "removed" || projected?.kind === "terminal";
  const close = useDockViewStore((state) => state.closeDocument);
  useEffect(() => {
    if (gone) close();
  }, [gone, close]);
  return gone || !document
    ? null
    : projected?.kind === "projected"
      ? { ...document, tab: projected.tab }
      : document;
}
export function usePresentedDockDocument(screen: ScreenKey) {
  const presentation = useContext(DesktopPresentation);
  return presentation ? (presentation.screen === screen ? presentation.document : null) : undefined;
}
