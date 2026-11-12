/**
 * ChatSurface — the one chat instance in the project view.
 *
 * Mounted once and never unmounted while the project is open, so the conversation never
 * reloads: the stream, scroll position and composer draft survive a move. The desktop moves
 * this same instance between main and the side by grid-area; only the band above it changes
 * (`header`), so the conversation below keeps its place in the tree.
 *
 * The phone's chat sheet mounts the surface only while the sheet is open, with its own header.
 */
import type { Work } from "@meridian/contracts/protocol";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PanePlaceContext } from "../pane-place";
import type { ContextRouteRequest } from "../routing/project-route";
import { pageSheetClass } from "../shell/tab-chip";
import { useNewChatAbout } from "../side/SideView";
import { ChatScreen } from "./ChatScreen";

export type ChatSurfaceProps = {
  projectId: string;
  threadId: string | null;
  /** A new chat's composer beside a document attaches that document. */
  about?: string | null;
  activeWork: Work | null;
  availableWorks: readonly Work[];
  place: "main" | "side";
  /** On the desktop the chat sits on a page, the side's inset from main's; the phone's sheet is its page. */
  presentation: "desktop" | "phone";
  /** When false the surface is hidden (the side closed, or main on the index) WITHOUT unmounting. */
  visible: boolean;
  onOpenContextTarget?: (target: ContextRouteRequest) => void;
  /** The band above the conversation. */
  header?: ReactNode;
};

export function ChatSurface({
  projectId,
  threadId,
  about = null,
  activeWork,
  availableWorks,
  place,
  presentation,
  visible,
  onOpenContextTarget,
  header,
}: ChatSurfaceProps) {
  const reportAbout = useNewChatAbout().report;
  return (
    <PanePlaceContext.Provider value={place}>
      <div
        aria-hidden={!visible}
        // Hidden but still mounted for persistence: `inert` keeps the live-but-invisible
        // composer and messages out of the tab order and pointer flow.
        inert={!visible}
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          !visible && "pointer-events-none opacity-0",
        )}
      >
        {header}
        <div
          className={cn(
            "main-pane flex min-h-0 flex-1 flex-col overflow-hidden",
            presentation === "desktop" && pageSheetClass(place === "side"),
          )}
        >
          <ChatScreen
            projectId={projectId}
            threadId={threadId}
            about={about}
            onAboutChange={place === "side" ? reportAbout : undefined}
            activeWork={activeWork}
            availableWorks={availableWorks}
            onOpenContextTarget={onOpenContextTarget}
            visible={visible}
          />
        </div>
      </div>
    </PanePlaceContext.Provider>
  );
}
