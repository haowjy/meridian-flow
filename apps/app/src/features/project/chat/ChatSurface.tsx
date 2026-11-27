import type { Work } from "@meridian/contracts/protocol";
import type { ReactNode } from "react";
import type { ContextRouteRequest } from "@/client/project-shell/project-route";
import { cn } from "@/lib/utils";
import { PanePlaceContext } from "../pane-place";
import { pageSheetClass } from "../shell/tab-chip";
import { useNewChatAbout } from "../side/SideView";
import { ChatScreen } from "./ChatScreen";

export type ChatSurfaceProps = {
  projectId: string;
  threadId: string | null;
  about?: string | null;
  activeWork: Work | null;
  availableWorks: readonly Work[];
  place: "main" | "side";
  presentation: "desktop" | "phone";
  visible: boolean;
  onOpenContextTarget?: (target: ContextRouteRequest) => void;
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
            presentation === "desktop" ? pageSheetClass(place === "side") : "paper",
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
