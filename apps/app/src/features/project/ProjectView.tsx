/**
 * ProjectView — the controlled project workspace shell.
 *
 * Renders the desktop project path (surface layout grid + per-screen pane
 * controller + persistent chat surface) for the active screen. The `$projectId`
 * route owns all navigation state; this shell only distributes route-owned
 * props to focused pane controllers and calls route handlers in response to
 * user actions.
 *
 * The Context destination is one component (`ContextViewer`) wrapping its
 * own files panel, tab strip, and editor/viewer body — see
 * `ContextPaneController`. The files panel's width/collapsed prefs now live
 * in their own dedicated store (`context/context-files-store.ts`), decoupled
 * from the shared project surface-prefs store.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useThreadDocumentResolver } from "@/features/chat/useThreadDocumentResolver";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { ChatPaneController } from "./ChatPaneController";
import { ContextViewerSurfaceController } from "./ContextPaneController";
import { type ChatPlacement, ChatSurface } from "./chat/ChatSurface";
import { HomePaneController } from "./HomePaneController";
import {
  type SlotGridSurface,
  SURFACE_WIDTH_BOUNDS,
  type SurfaceId,
  useProjectLayout,
  useProjectSurfacePrefsActions,
  useProjectSurfacePrefsStore,
} from "./layout";
import { MobileProject } from "./mobile/MobileProject";
import { ContextRail, type RailUploadTarget } from "./shell/ContextRail";
import { LeftSidebar } from "./shell/LeftSidebar";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";
import { ProjectShell } from "./shell/ProjectShell";
import type { ScreenKey } from "./shell/screens";

/** Minimum width (px) the main content column may shrink to on desktop. */
const MAIN_MIN_WIDTH = 360;
const COMPACT_DESKTOP_QUERY = "(max-width: 899px)";
const NARROW_DESKTOP_QUERY = "(max-width: 767px)";

export type ProjectViewProps = {
  projectId: string;
  /** Resolved screen key from the route (defaults to home). */
  activeScreen: ScreenKey;
  /** Active chat / subagent thread, also used by the persistent dock. */
  activeThreadId: string | null;
  /** Active context scheme (manuscript/kb/user/work), when `screen=context`. */
  activeContextScheme: ProjectContextTreeScheme | null;
  /** Active context folder retained in route state for future context navigation. */
  activeContextFolder: string | null;
  /** Active context file path, when `screen=context`. */
  activeContextPath: string | null;
  /** Phone-only routed Results auxiliary surface (`?results=`). Desktop ignores it. */
  resultsOpen: boolean;
  onSelectScreen: (screen: ScreenKey) => void;
  onSelectThread: (threadId: string) => void;
  onSelectDockThread: (threadId: string) => void;
  onSelectContextScheme: (scheme: ProjectContextTreeScheme) => void;
  onExitContextScheme: () => void;
  onSelectContextFolder: (folder: string) => void;
  /**
   * Selects a context file. When `scheme` is provided, the URL records it.
   */
  onSelectContextPath: (
    path: string,
    scheme?: ProjectContextTreeScheme,
    options?: { replace?: boolean },
  ) => void;
  /**
   * Sets the active document (scheme + path) in the URL WITHOUT switching
   * screens. The rail viewer reads scheme/path off the URL — same state the
   * center context viewer sees. Distinct from `onSelectContextPath`, which
   * navigates to the context screen.
   */
  onSetActiveDocument: (path: string, scheme: ProjectContextTreeScheme) => void;
  onOpenResults: () => void;
  onCloseResults: () => void;
};

export function ProjectView(props: ProjectViewProps) {
  // Gate the whole project on prefs-store hydration so DesktopProject mounts
  // exactly once against final persisted prefs. rehydrate() is synchronous
  // (localStorage), so this is at most one frame — no visible flash. Gating here
  // (not inside DesktopProject) avoids a conditional-hook ordering violation.
  const hydrated = useProjectSurfacePrefsStore((s) => s._hydrated);
  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      {hydrated ? <HydratedProject {...props} /> : null}
    </div>
  );
}

function HydratedProject(props: ProjectViewProps) {
  const usePhone = usePhoneShell();
  if (usePhone === null) return null;
  return usePhone ? <MobileProject {...props} /> : <DesktopProject {...props} />;
}

/* ── Desktop project ─────────────────────────────────────────────── */

/** A PaneHeader expand control derived from a stable surface id. */
function expandToggle(
  surfaceId: SurfaceId,
  open: boolean,
  onSetCollapsed: (surfaceId: SurfaceId, collapsed: boolean) => void,
  label: string,
): PaneHeaderRailToggle {
  return { open, onExpand: () => onSetCollapsed(surfaceId, false), label };
}

/**
 * Desktop layout for every destination. Persistent shell state lives on stable
 * surfaces; per-screen rendering is delegated to pane controllers that receive
 * only the props they need.
 */
function DesktopProject(props: ProjectViewProps) {
  // useProjectLayout internally subscribes to prefs + slotPrefs and returns a
  // merged SurfaceLayoutMap; that single subscription drives all layout-driven
  // re-renders — no separate whole-prefs subscription is needed.
  const layout = useProjectLayout(props.activeScreen);

  // Rail viewer state lives at this level: the rail and both chat-popover
  // sites all consume `handleOpenInRail`, so one source of truth here keeps
  // popover-click and rail-tree-click on the same path. Viewer mode is
  // DERIVED by the rail from these props + URL (see ContextRail).
  const [railUploadTarget, setRailUploadTarget] = useState<RailUploadTarget | null>(null);
  const [railViewerDismissed, setRailViewerDismissed] = useState(false);
  // Reset the dismissed flag whenever the URL points at a new context doc,
  // so opening a different file via popover/tree re-enters viewer mode even
  // if the writer had just clicked Back on the previous one.
  const lastDocKeyRef = useRef<string | null>(null);
  const docKey =
    props.activeContextScheme && props.activeContextPath
      ? `${props.activeContextScheme}:${props.activeContextPath}`
      : null;
  if (docKey !== lastDocKeyRef.current) {
    lastDocKeyRef.current = docKey;
    if (railViewerDismissed) setRailViewerDismissed(false);
  }

  const { onSetActiveDocument } = props;
  const handleOpenInRail = useCallback(
    (doc: {
      documentId: string;
      scheme: ProjectContextTreeScheme | null;
      path: string | null;
      name: string;
      fileType: RailUploadTarget["fileType"];
      mimeType: RailUploadTarget["mimeType"];
      editable: boolean;
      filetype: RailUploadTarget["filetype"];
      schemaType: RailUploadTarget["schemaType"];
    }) => {
      if (doc.scheme && doc.path) {
        // Context doc: identity lives in the URL — rail derives viewer mode
        // from it. Clear any upload target so the two viewers don't fight.
        onSetActiveDocument(doc.path, doc.scheme);
        setRailUploadTarget(null);
        setRailViewerDismissed(false);
        return;
      }
      // Thread upload: no URL representation, rail-local target.
      setRailUploadTarget({
        documentId: doc.documentId,
        name: doc.name,
        fileType: doc.fileType,
        mimeType: doc.mimeType,
        editable: doc.editable,
        filetype: doc.filetype,
        schemaType: doc.schemaType,
      });
      setRailViewerDismissed(false);
    },
    [onSetActiveDocument],
  );

  const resolveThreadDocument = useThreadDocumentResolver(props.activeThreadId);
  const handlePopoverOpen = useCallback(
    (documentId: string) => {
      const resolved = resolveThreadDocument(documentId);
      if (!resolved) return;
      const row = resolved.kind === "upload" ? resolved.upload : resolved.recent;
      handleOpenInRail({
        documentId: row.documentId,
        scheme: row.scheme,
        path: row.path,
        name: row.name,
        fileType: row.fileType,
        mimeType: row.mimeType,
        editable: row.editable,
        filetype: row.filetype,
        schemaType: row.schemaType,
      });
    },
    [handleOpenInRail, resolveThreadDocument],
  );

  const { setSurfaceCollapsed, setSurfaceWidth, setDockCollapsed, setDockWidth } =
    useProjectSurfacePrefsActions();
  useCompactDesktopAutoCollapse(setDockCollapsed, setSurfaceCollapsed);

  const isOpen = (surfaceId: SurfaceId) => !layout[surfaceId].collapsed;
  // Collapse/expand calls targeting a surface that is currently the dock
  // occupant drive the shared dock pref instead of the surface's own pref —
  // the dock reads as one persistent sidebar across screens.
  const setCollapsedFor = (surfaceId: SurfaceId, collapsed: boolean) => {
    if (layout[surfaceId].slot === "dock") {
      setDockCollapsed(collapsed);
      return;
    }
    setSurfaceCollapsed(surfaceId, collapsed);
  };
  const close = (surfaceId: SurfaceId) => () => setCollapsedFor(surfaceId, true);
  const surfaceToggle = (surfaceId: SurfaceId, label: string) =>
    expandToggle(surfaceId, isOpen(surfaceId), setCollapsedFor, label);

  const screen = props.activeScreen;
  // The chat is mounted ONCE as a direct child of the project grid, so it
  // never remounts when the destination changes (no reload of the live
  // conversation). It moves center↔dock by changing its wrapper grid-area.
  const chatPlacement: ChatPlacement = screen === "chat" ? "center" : "dock";

  const stableSurfaces: SlotGridSurface[] = [
    {
      id: "threads",
      children: (
        <LeftSidebar
          projectId={props.projectId}
          activeScreen={props.activeScreen}
          activeThreadId={props.activeThreadId}
          onSelectScreen={props.onSelectScreen}
          onSelectThread={props.onSelectThread}
          onCollapse={close("threads")}
        />
      ),
    },
    {
      id: "context-rail",
      children: (
        <ContextRail
          projectId={props.projectId}
          threadId={props.activeThreadId}
          activeScheme={props.activeContextScheme}
          activePath={props.activeContextPath}
          railUploadTarget={railUploadTarget}
          railViewerDismissed={railViewerDismissed}
          onSetActiveDocument={props.onSetActiveDocument}
          onOpenUpload={(target) => {
            setRailUploadTarget(target);
            setRailViewerDismissed(false);
          }}
          onDismissViewer={() => {
            setRailViewerDismissed(true);
            setRailUploadTarget(null);
          }}
          onClose={close("context-rail")}
        />
      ),
    },
    {
      id: "context-viewer",
      children: (
        <ContextViewerSurfaceController
          projectId={props.projectId}
          activeThreadId={props.activeThreadId}
          activeContextScheme={props.activeContextScheme}
          activeContextPath={props.activeContextPath}
          active={props.activeScreen === "context"}
          sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
          dockToggle={surfaceToggle("chat", t`Expand chat`)}
          onSelectContextPath={props.onSelectContextPath}
        />
      ),
    },
    {
      id: "chat",
      children: (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Stable keys pin chat-surface identity so toggling this header
              controller never risks reconciling the live conversation subtree. */}
          {chatPlacement === "center" ? (
            <ChatPaneController
              key="chat-pane-controller"
              projectId={props.projectId}
              activeThreadId={props.activeThreadId}
              sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
              contextToggle={surfaceToggle("context-rail", t`Expand context`)}
              onSelectThread={props.onSelectThread}
              onOpenDocument={handlePopoverOpen}
            />
          ) : null}
          <ChatSurface
            key="chat-surface"
            projectId={props.projectId}
            activeThreadId={props.activeThreadId}
            // Centered chat owns the route (`?screen` follows it); the dock must
            // only change which conversation it shows, never the screen — so it
            // uses onSelectDockThread (sets `?thread`, keeps `?screen`).
            onSelectThread={
              chatPlacement === "center" ? props.onSelectThread : props.onSelectDockThread
            }
            placement={chatPlacement}
            // Mounted-but-hidden when the dock is collapsed, so the live
            // conversation survives a close/reopen.
            visible={chatPlacement === "center" || isOpen("chat")}
            onCloseDock={close("chat")}
            onSelectContextPath={props.onSelectContextPath}
            onOpenDocument={handlePopoverOpen}
          />
        </div>
      ),
    },
  ];

  return (
    <ProjectShell
      layout={layout}
      surfaces={stableSurfaces}
      onSetWidth={setSurfaceWidth}
      onSetCollapsed={setSurfaceCollapsed}
      onSetDockWidth={setDockWidth}
      onSetDockCollapsed={setDockCollapsed}
      bounds={SURFACE_WIDTH_BOUNDS}
      mainMinWidth={MAIN_MIN_WIDTH}
    >
      {renderDesktopPane(props, surfaceToggle)}
    </ProjectShell>
  );
}

type SurfaceToggleFactory = (surfaceId: SurfaceId, label: string) => PaneHeaderRailToggle;

function renderDesktopPane(props: ProjectViewProps, surfaceToggle: SurfaceToggleFactory) {
  switch (props.activeScreen) {
    case "home":
      return (
        <HomePaneController
          projectId={props.projectId}
          sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
          chatToggle={surfaceToggle("chat", t`Expand chat`)}
          onSelectThread={props.onSelectThread}
        />
      );
    case "chat":
      return null;
    case "context":
      // Context owns no destination header — the tab strip absorbs the
      // sidebar/dock expand toggles, and the per-variant editor toolbar
      // owns the files-collapse affordance. See `ContextViewer`.
      return null;
  }
}

/**
 * Collapse chrome once when entering compact desktop widths. The listener only
 * runs on mount/media-boundary changes, so a user can re-expand rails without
 * the effect immediately fighting that preference.
 */
function useCompactDesktopAutoCollapse(
  setDockCollapsed: (collapsed: boolean) => void,
  setSurfaceCollapsed: (surfaceId: SurfaceId, collapsed: boolean) => void,
) {
  useEffect(() => {
    const compact = window.matchMedia(COMPACT_DESKTOP_QUERY);
    const narrow = window.matchMedia(NARROW_DESKTOP_QUERY);
    const apply = () => {
      if (compact.matches) setDockCollapsed(true);
      if (narrow.matches) setSurfaceCollapsed("threads", true);
    };
    compact.addEventListener("change", apply);
    narrow.addEventListener("change", apply);
    apply();
    return () => {
      compact.removeEventListener("change", apply);
      narrow.removeEventListener("change", apply);
    };
  }, [setDockCollapsed, setSurfaceCollapsed]);
}
