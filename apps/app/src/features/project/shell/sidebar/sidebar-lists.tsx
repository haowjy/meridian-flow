import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { MessageSquare, PenLine } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback } from "react";
import { type SidebarList, useSidebarList, writeSidebarList } from "@/client/project-shell/store";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { useWorks } from "@/client/query/useWorks";
import { RailScratchSection } from "../../chat/ChatScratch";
import { useAccountId } from "../../context/account-feature-context";
import { useChatNavigation } from "../../routing/chat-navigation";
import { ChatsBody } from "./ChatsBody";
import { SourcesBody } from "./SourcesBody";

export type SidebarListProps = {
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
  /** The phone drawer closes after a pick. */
  onPicked?: () => void;
};

function FilesList(props: SidebarListProps) {
  return <SourcesBody {...props} />;
}

function ChatsList({
  projectId,
  chatThreadId,
  scopeWorkId,
  onShowWork,
  onPicked,
}: SidebarListProps) {
  const chat = useChatNavigation();
  const { noWork } = useWorks(projectId);
  return (
    <ChatsBody
      projectId={projectId}
      scopeWorkId={scopeWorkId}
      noWorkId={noWork?.id ?? null}
      currentThreadId={chatThreadId}
      // The drawer closes once the navigation commits: a rejected one leaves it open.
      onOpenChat={(threadId) => void chat.openChat(threadId).then(() => onPicked?.())}
      onNewChat={() => void chat.openNewChat().then(() => onPicked?.())}
      onShowAllChats={() => void chat.openChatIndex().then(() => onPicked?.())}
      onShowWork={onShowWork}
      // Renders nothing while no chat is open.
      footer={
        <RailScratchSection projectId={projectId} threadId={chatThreadId} onPicked={onPicked} />
      }
    />
  );
}

/**
 * The lists the left sidebar can show, in switch order, for the desktop sidebar and the phone
 * drawer alike. A third list is one row.
 */
export const SIDEBAR_LISTS = {
  files: { label: () => t`Write`, icon: PenLine, Body: FilesList },
  chats: { label: () => t`Chat`, icon: MessageSquare, Body: ChatsList },
} satisfies Record<
  SidebarList,
  { label: () => string; icon: LucideIcon; Body: ComponentType<SidebarListProps> }
>;

export const SIDEBAR_LIST_KEYS = Object.keys(SIDEBAR_LISTS) as SidebarList[];

/** This tab's sidebar list, and the one command that changes it: no address, no navigation. */
export function useSidebarListState(projectId: string) {
  const accountId = useAccountId();
  const list = useSidebarList(accountId, projectId);
  const setList = useCallback(
    (next: SidebarList) => writeSidebarList(accountId, projectId, next),
    [accountId, projectId],
  );
  return { list, setList };
}
