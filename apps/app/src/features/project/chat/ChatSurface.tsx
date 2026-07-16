/**
 * ChatSurface — the single, persistent chat instance for the desktop project.
 *
 * Mounted ONCE above the destination switch (see `DesktopProject`) and never
 * unmounted when the user moves between Home / Chat / Context — so the
 * conversation never reloads: the WS stream, scroll position, and composer
 * draft all survive a destination change. The project SlotGrid moves this
 * same instance between the centered Chat slot and the right dock slot by
 * changing only its persistent slot's grid-area.
 *
 * In the dock it renders through `DockShell`, which adds the tabbed header
 * (Chat | Changes) and can swap the body to the work-scoped Changes view. The
 * shell is a passthrough in `center` placement so this subtree keeps the same
 * tree position across center↔dock moves — the chat is never reconciled away.
 */
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme, Work } from "@meridian/contracts/protocol";
import { ChatThreadTitle } from "@/features/chat/ChatThreadHeader";
import { cn } from "@/lib/utils";
import { DockShell } from "../dock/DockShell";
import { PaneTitle } from "../PaneTitle";
import type { ScreenKey } from "../shell/screens";
import { ChatScreen } from "./ChatScreen";
import { useResolvedChatThread } from "./chat-thread-resolution";

/** `center` = the wide main column (Chat dest); `dock` = right rail (Home/Context). */
export type ChatPlacement = "center" | "dock";

/** Width of the docked chat — kept in sync with the content reflow padding. */
export const CHAT_DOCK_WIDTH = "clamp(20rem,28vw,26rem)";

export type ChatSurfaceProps = {
  projectId: string;
  activeThreadId: string | null;
  activeWork: Work | null;
  /** Active screen — drives the dock view set when this surface is docked. */
  activeScreen: ScreenKey;
  onSelectThread: (threadId: string) => void;
  placement: ChatPlacement;
  /** When false the surface is hidden (e.g. Settings / closed dock) WITHOUT unmounting. */
  visible: boolean;
  /**
   * Collapse the dock. Only meaningful in `dock` placement — the dock header
   * carries the close control (matching the Context rail). The centered chat
   * owns no close (its rail toggles live in the PaneHeader).
   */
  onCloseDock?: () => void;
  onSelectContextPath?: (path: string, scheme?: ProjectContextTreeScheme) => void;
};

export function ChatSurface({
  projectId,
  activeThreadId,
  activeWork,
  activeScreen,
  onSelectThread,
  placement,
  visible,
  onCloseDock,
  onSelectContextPath,
}: ChatSurfaceProps) {
  // The header must name the SAME thread the body resolves — the route id is
  // null on Home/Context, where ChatScreen falls back without route
  // write-back. One shared resolution keeps title and conversation in sync.
  const { resolvedThreadId } = useResolvedChatThread(projectId, activeThreadId);
  return (
    <div
      aria-hidden={!visible}
      // Hidden (Settings / collapsed dock) but still mounted for persistence —
      // `inert` keeps the live-but-invisible composer/messages out of the tab
      // order and pointer flow so keystrokes can't land in an unseen chat.
      inert={!visible}
      className={cn(
        "main-pane flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        placement === "center" && "page-sheet",
        !visible && "pointer-events-none opacity-0",
      )}
    >
      <DockShell
        placement={placement}
        screen={activeScreen}
        onClose={onCloseDock}
        threadSelect={
          resolvedThreadId ? (
            <ChatThreadTitle
              projectId={projectId}
              threadId={resolvedThreadId}
              onSelectThread={onSelectThread}
            />
          ) : (
            <PaneTitle>
              <Trans>Chat</Trans>
            </PaneTitle>
          )
        }
      >
        <ChatScreen
          projectId={projectId}
          threadId={activeThreadId}
          activeWork={activeWork}
          onSelectThread={onSelectThread}
          onSelectContextPath={onSelectContextPath}
          // Both placements now carry external chrome (PaneHeader for center, the
          // dock header for dock), so ChatScreen never renders its own. Only the
          // centered (destination-owning) chat may write its fallback thread to
          // the route. A dock must not, or it hijacks navigation.
          writeThreadToRoute={placement === "center"}
        />
      </DockShell>
    </div>
  );
}
