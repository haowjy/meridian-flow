// @ts-nocheck
/**
 * WorkbenchView — the controlled workbench workspace shell.
 *
 * Renders the desktop workbench path (surface layout grid + per-screen pane
 * controller + persistent chat surface) for the active screen. The `$workbenchId`
 * route owns all navigation state; this shell only distributes route-owned
 * props to focused pane controllers and calls route handlers in response to
 * user actions.
 *
 * The Context destination is one component (`ContextViewer`) wrapping its
 * own files panel, tab strip, and editor/viewer body — see
 * `ContextPaneController`. The files panel's width/collapsed prefs now live
 * in their own dedicated store (`context/context-files-store.ts`), decoupled
 * from the shared workbench surface-prefs store.
 */
import { t } from "@lingui/core/macro";
import type { WorkbenchContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect } from "react";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { ChatPaneController } from "./ChatPaneController";
import { ContextViewerSurfaceController } from "./ContextPaneController";
import { type ChatPlacement, ChatSurface } from "./chat/ChatSurface";
import { HomePaneController } from "./HomePaneController";
import {
  type SlotGridSurface,
  SURFACE_WIDTH_BOUNDS,
  type SurfaceId,
  useWorkbenchLayout,
  useWorkbenchSurfacePrefsActions,
  useWorkbenchSurfacePrefsStore,
} from "./layout";
import { MobileWorkbench } from "./mobile/MobileWorkbench";
import { ContextSidebar } from "./shell/ContextSidebar";
import { LeftSidebar } from "./shell/LeftSidebar";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";
import type { ScreenKey } from "./shell/screens";
import { WorkbenchShell } from "./shell/WorkbenchShell";

/** Minimum width (px) the main content column may shrink to on desktop. */
const MAIN_MIN_WIDTH = 360;
const COMPACT_DESKTOP_QUERY = "(max-width: 899px)";
const NARROW_DESKTOP_QUERY = "(max-width: 767px)";

export type ProjectViewProps = {
  workbenchId: string;
  /** Resolved screen key from the route (defaults to home). */
  activeScreen: ScreenKey;
  /** Active chat / subagent thread, also used by the persistent dock. */
  activeThreadId: string | null;
  /** Active context scheme (kb/user/work/fs1), when `screen=context`. */
  activeContextScheme: WorkbenchContextTreeScheme | null;
  /** Active context folder retained in route state for future context navigation. */
  activeContextFolder: string | null;
  /** Active context file path, when `screen=context`. */
  activeContextPath: string | null;
  /** Phone-only routed Results auxiliary surface (`?results=`). Desktop ignores it. */
  resultsOpen: boolean;
  onSelectScreen: (screen: ScreenKey) => void;
  onSelectThread: (threadId: string) => void;
  onSelectDockThread: (threadId: string) => void;
  onSelectContextScheme: (scheme: WorkbenchContextTreeScheme) => void;
  onExitContextScheme: () => void;
  onSelectContextFolder: (folder: string) => void;
  /**
   * Selects a context file. When `scheme` is provided, the URL records it.
   */
  onSelectContextPath: (
    path: string,
    scheme?: WorkbenchContextTreeScheme,
    options?: { replace?: boolean },
  ) => void;
  onOpenResults: () => void;
  onCloseResults: () => void;
};

export function WorkbenchView(props: ProjectViewProps) {
  // Gate the whole workbench on prefs-store hydration so DesktopWorkbench mounts
  // exactly once against final persisted prefs. rehydrate() is synchronous
  // (localStorage), so this is at most one frame — no visible flash. Gating here
  // (not inside DesktopWorkbench) avoids a conditional-hook ordering violation.
  const hydrated = useWorkbenchSurfacePrefsStore((s) => s._hydrated);
  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      {hydrated ? <HydratedWorkbench {...props} /> : null}
    </div>
  );
}

function HydratedWorkbench(props: ProjectViewProps) {
  const usePhone = usePhoneShell();
  if (usePhone === null) return null;
  return usePhone ? <MobileWorkbench {...props} /> : <DesktopWorkbench {...props} />;
}

/* ── Desktop workbench ─────────────────────────────────────────────── */

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
function DesktopWorkbench(props: ProjectViewProps) {
  // useWorkbenchLayout internally subscribes to prefs + slotPrefs and returns a
  // merged SurfaceLayoutMap; that single subscription drives all layout-driven
  // re-renders — no separate whole-prefs subscription is needed.
  const layout = useWorkbenchLayout(props.activeScreen);

  const { setSurfaceCollapsed, setSurfaceWidth, setDockCollapsed, setDockWidth } =
    useWorkbenchSurfacePrefsActions();
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
  // The chat is mounted ONCE as a direct child of the workbench grid, so it
  // never remounts when the destination changes (no reload of the live
  // conversation). It moves center↔dock by changing its wrapper grid-area.
  const chatPlacement: ChatPlacement = screen === "chat" ? "center" : "dock";

  const stableSurfaces: SlotGridSurface[] = [
    {
      id: "threads",
      children: (
        <LeftSidebar
          workbenchId={props.workbenchId}
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
        <ContextSidebar
          threadId={props.activeThreadId}
          workbenchId={props.workbenchId}
          onClose={close("context-rail")}
        />
      ),
    },
    {
      id: "context-viewer",
      children: (
        <ContextViewerSurfaceController
          workbenchId={props.workbenchId}
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
              workbenchId={props.workbenchId}
              activeThreadId={props.activeThreadId}
              sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
              contextToggle={surfaceToggle("context-rail", t`Expand context`)}
              onSelectThread={props.onSelectThread}
            />
          ) : null}
          <ChatSurface
            key="chat-surface"
            workbenchId={props.workbenchId}
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
          />
        </div>
      ),
    },
  ];

  return (
    <WorkbenchShell
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
    </WorkbenchShell>
  );
}

type SurfaceToggleFactory = (surfaceId: SurfaceId, label: string) => PaneHeaderRailToggle;

function renderDesktopPane(props: ProjectViewProps, surfaceToggle: SurfaceToggleFactory) {
  switch (props.activeScreen) {
    case "home":
      return (
        <HomePaneController
          workbenchId={props.workbenchId}
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
