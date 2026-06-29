/**
 * ChatSurface — the single, persistent chat instance for the desktop project.
 *
 * Mounted ONCE above the destination switch (see `DesktopProject`) and never
 * unmounted when the user moves between Home / Chat / Context — so the
 * conversation never reloads: the WS stream, scroll position, and composer
 * draft all survive a destination change. The project SlotGrid moves this
 * same instance between the centered Chat slot and the right dock slot by
 * changing only the parent wrapper's grid-area.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { ChatThreadTitle } from "@/features/chat/ChatThreadHeader";
import { ThreadContentsPopover } from "@/features/chat/ThreadContentsPopover";
import { cn } from "@/lib/utils";

import { PaneTitle } from "../PaneTitle";
import { RailHeader } from "../shell/RailHeader";
import { ChatScreen } from "./ChatScreen";

/** `center` = the wide main column (Chat dest); `dock` = right rail (Home/Context). */
export type ChatPlacement = "center" | "dock";

/** Width of the docked chat — kept in sync with the content reflow padding. */
export const CHAT_DOCK_WIDTH = "clamp(20rem,28vw,26rem)";

export type ChatSurfaceProps = {
  projectId: string;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  placement: ChatPlacement;
  /** When false the surface is hidden (e.g. Settings / closed dock) WITHOUT unmounting. */
  visible: boolean;
  /**
   * Collapse the dock. Only meaningful in `dock` placement — the dock's
   * RailHeader carries the close control (matching the Context rail). The
   * centered chat owns no close (its rail toggles live in the PaneHeader).
   */
  onCloseDock?: () => void;
  onSelectContextPath?: (path: string, scheme?: ProjectContextTreeScheme) => void;
  /** Popover document-open handoff. Resolved by the parent into the rail viewer. */
  onOpenDocument?: (documentId: string) => void;
};

export function ChatSurface({
  projectId,
  activeThreadId,
  onSelectThread,
  placement,
  visible,
  onCloseDock,
  onSelectContextPath,
  onOpenDocument,
}: ChatSurfaceProps) {
  return (
    <div
      aria-hidden={!visible}
      // Hidden (Settings / collapsed dock) but still mounted for persistence —
      // `inert` keeps the live-but-invisible composer/messages out of the tab
      // order and pointer flow so keystrokes can't land in an unseen chat.
      inert={!visible}
      className={cn(
        "main-pane flex h-full min-h-0 w-full flex-col overflow-hidden",
        !visible && "pointer-events-none opacity-0",
      )}
    >
      {placement === "dock" && onCloseDock ? (
        // The dock carries its own chrome via the shared RailHeader: thread
        // switcher on the left, collapse control on the right — identical to the
        // Context rail. The centered chat instead uses the Chat-dest PaneHeader.
        <RailHeader
          onClose={onCloseDock}
          closeLabel={t`Collapse chat  ]`}
          side="right"
          actions={
            <ThreadContentsPopover threadId={activeThreadId} onOpenDocument={onOpenDocument} />
          }
        >
          {activeThreadId ? (
            <ChatThreadTitle
              projectId={projectId}
              threadId={activeThreadId}
              onSelectThread={onSelectThread}
            />
          ) : (
            <PaneTitle>
              <Trans>Chat</Trans>
            </PaneTitle>
          )}
        </RailHeader>
      ) : null}
      <ChatScreen
        projectId={projectId}
        threadId={activeThreadId}
        onSelectThread={onSelectThread}
        placement={placement}
        onSelectContextPath={onSelectContextPath}
        // Both placements now carry external chrome (PaneHeader for center, the
        // RailHeader above for dock), so ChatScreen never renders its own.
        // Only the centered (destination-owning) chat may write its fallback
        // thread to the route. A dock must not, or it hijacks navigation.
        writeThreadToRoute={placement === "center"}
      />
    </div>
  );
}
