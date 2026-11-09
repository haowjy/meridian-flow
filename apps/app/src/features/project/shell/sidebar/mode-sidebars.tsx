import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ComponentType } from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { useWorks } from "@/client/query/useWorks";
import { RailScratchSection } from "../../chat/ChatScratch";
import type { ModeKey } from "../../layout/modes";
import { useChatNavigation } from "../../routing/chat-navigation";
import { ChatsBody } from "./ChatsBody";
import { SourcesBody } from "./SourcesBody";

export type ModeSidebarProps = {
  projectId: string;
  editorWorkId: string | null;
  /** The chat on screen: its row reads as current and its Scratch follows it. */
  chatThreadId: string | null;
  contextLive: boolean;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  onSelectFile: (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => void;
  scopeWorkId: string | null;
  onShowWork: (workId: string) => void;
};

function WriteSidebar(props: ModeSidebarProps) {
  return <SourcesBody {...props} />;
}

function ChatSidebar({
  projectId,
  editorWorkId,
  chatThreadId,
  scopeWorkId,
  onShowWork,
}: ModeSidebarProps) {
  const chat = useChatNavigation();
  const { noWork } = useWorks(projectId);
  return (
    <ChatsBody
      projectId={projectId}
      scopeWorkId={scopeWorkId}
      noWorkId={noWork?.id ?? null}
      currentThreadId={chatThreadId}
      onOpenChat={(threadId) => void chat.openChat(threadId)}
      onNewChat={() => void chat.openChatIndex()}
      onShowAllChats={() => void chat.openChatIndex()}
      onShowWork={onShowWork}
      // Renders nothing while no chat is open.
      footer={
        <RailScratchSection
          projectId={projectId}
          threadId={chatThreadId}
          editorWorkId={editorWorkId}
        />
      }
    />
  );
}

/** Each mode's sidebar, under the mode switch. Exhaustive over `MODES`: a new mode adds a row. */
export const MODE_SIDEBARS = {
  write: WriteSidebar,
  chat: ChatSidebar,
} satisfies Record<ModeKey, ComponentType<ModeSidebarProps>>;
