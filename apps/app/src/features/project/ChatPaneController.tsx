/**
 * ChatPaneController — main's band while main holds a chat: main's tabs with the chat as the
 * active chip after them (one click returns to a document), and the chat's own controls.
 *
 * The persistent `ChatSurface` owns the live conversation instance; this renders only its chrome.
 */

import type { ReactNode } from "react";
import { ChatFilesMenu } from "@/features/chat/ChatFilesMenu";
import { ChatThreadTitle } from "@/features/chat/ChatThreadTitle";
import { SubagentHeader } from "@/features/chat/SubagentHeader";
import { useThreadActivity } from "@/features/chat/useThreadActivity";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";
import { MainHeader } from "./shell/MainHeader";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ChatPaneControllerProps = {
  projectId: string;
  threadId: string | null;
  open: OpenContextRoute;
  onShowRecents: (options: { replace: boolean }) => void;
  sidebarToggle: PaneHeaderRailToggle;
  contextToggle: PaneHeaderRailToggle;
  /** While the side is closed: the control naming what it would show. */
  closedSide?: ReactNode;
};

export function ChatPaneController({
  projectId,
  threadId,
  open,
  onShowRecents,
  sidebarToggle,
  contextToggle,
  closedSide,
}: ChatPaneControllerProps) {
  const activity = useThreadActivity({
    threadId: threadId ?? "",
    seed: null,
  });
  return (
    <MainHeader
      projectId={projectId}
      open={open}
      mainKey={null}
      // The centered chat body is page-sheet: the switcher wears the active-tab chip so the page
      // continues up into the band.
      current={<ChatThreadTitle projectId={projectId} threadId={threadId} variant="tab" />}
      onShowRecents={onShowRecents}
      sidebarToggle={sidebarToggle}
      sideToggle={contextToggle}
      closedSide={closedSide}
      actions={
        threadId ? (
          <>
            <ChatFilesMenu projectId={projectId} threadId={threadId} />
            <SubagentHeader threadId={threadId} nodes={activity.activity.children} />
          </>
        ) : null
      }
    />
  );
}
