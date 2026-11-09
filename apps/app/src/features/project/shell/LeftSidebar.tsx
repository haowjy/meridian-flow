/**
 * LeftSidebar — the desktop project sidebar. The header holds the project menu,
 * then the Work scope, then the mode switch. The body follows the mode: sources
 * in Write, chats in Chat. Both bodies stay mounted (the hidden one inert), so
 * tree expansion and scroll survive a mode switch. The phone drawer composes
 * `WorkspaceNavBody` instead.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useRef } from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { useWorks } from "@/client/query/useWorks";
import { useSelectedContextTab } from "@/client/stores";
import { AccountMenu } from "@/features/account/AccountMenu";
import { useAccountResourceProjection } from "../context/account-feature-context";
import { projectResourceTab } from "../context/context-tab-from-file";
import { useOpenProjectDocument } from "../context/open-project-document";
import { modeMeta } from "../layout/modes";
import { modeOf } from "../layout/placement";
import { useChatNavigation } from "../routing/chat-navigation";
import { useScreenCommands } from "../routing/ProjectNavigationContext";
import { useWorkScope } from "../use-work-scope";
import { InlineProjectTitle, type ProjectTitleEdit } from "./InlineProjectTitle";
import { PanelToggleSpacer } from "./PanelToggleButton";
import { ProjectMenu } from "./ProjectMenu";
import type { ScreenKey } from "./screens";
import { ChatsBody } from "./sidebar/ChatsBody";
import { ModeSwitch } from "./sidebar/ModeSwitch";

import { SourcesBody } from "./sidebar/SourcesBody";
import { WorkScopePicker } from "./sidebar/WorkScopePicker";
import type { TitleEditHandle } from "./TitleEditSlot";

type LeftSidebarProps = {
  projectId: string;
  projectTitle: string;
  titleEdit: ProjectTitleEdit;
  activeScreen: ScreenKey;
  editorWorkId: string | null;
  /** The chat on screen: Scratch follows it, and its row reads as current. */
  chatThreadId: string | null;
  contextLive: boolean;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  onSelectScreen: (screen: ScreenKey) => void;
};

export function LeftSidebar({
  projectId,
  projectTitle,
  titleEdit,
  activeScreen,
  editorWorkId,
  chatThreadId,
  contextLive,
  activeContextScheme,
  activeContextPath,
  onSelectScreen,
}: LeftSidebarProps) {
  const screenCommands = useScreenCommands();
  const chat = useChatNavigation();
  const titleEditor = useRef<TitleEditHandle>(null);
  const treePane = useRef<HTMLDivElement>(null);
  const openDocument = useOpenProjectDocument(projectId);
  const { noWork } = useWorks(projectId);
  const scope = useWorkScope(projectId);
  const mode = modeOf(activeScreen);

  const handleSelectFile = (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => {
    // The tree is navigation: on every screen, a pick goes to the Editor, unlike a chat
    // mention, which peeks in the dock. Identity, not the path: a kept file under a
    // rename is still this row's document.
    void openDocument({
      documentId: file.documentId,
      known: { scheme, file, workId: editorWorkId },
      workId: editorWorkId ?? undefined,
      ...options,
    });
  };
  // On the Chat screen the row to highlight is the document open in the dock.
  const selectedTab = useSelectedContextTab(projectId);
  const { records, placement } = useAccountResourceProjection(projectId);
  const projectedSelected = selectedTab
    ? projectResourceTab(projectId, selectedTab, records, placement)
    : null;
  const docked =
    activeScreen === "chat" &&
    selectedTab &&
    projectedSelected?.kind !== "removed" &&
    projectedSelected?.kind !== "terminal"
      ? projectedSelected?.kind === "projected"
        ? projectedSelected.tab
        : selectedTab
      : null;
  const treeActiveScheme = docked
    ? docked.kind === "new"
      ? "unfiled"
      : docked.scheme
    : activeContextScheme;
  const treeActivePath = docked ? (docked.kind === "new" ? null : docked.path) : activeContextPath;

  return (
    <nav
      aria-label={t`Workspace navigation`}
      className="relative flex h-full min-h-0 w-full flex-col gap-2 pb-1 text-foreground"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <PanelToggleSpacer />
        <InlineProjectTitle
          editRef={titleEditor}
          title={projectTitle}
          {...titleEdit}
          className="focus-ring flex h-8 min-w-0 flex-1 cursor-default items-center rounded-md px-2 text-left text-[14px] font-semibold hover:bg-sidebar-accent"
          inputClassName="h-8 px-2 text-[14px] font-semibold"
        />
        <ProjectMenu
          key={projectId}
          projectId={projectId}
          project={projectTitle}
          onRename={() => titleEditor.current?.start(projectTitle)}
        />
        <AccountMenu />
      </div>

      <WorkScopePicker
        projectId={projectId}
        workId={scope.workId}
        onPick={scope.setWorkId}
        onManage={() => void screenCommands?.showWork()}
      />
      <ModeSwitch
        mode={mode}
        onSelect={(next) => {
          if (next !== mode) onSelectScreen(modeMeta(next).screen);
        }}
      />

      <SourcesBody
        projectId={projectId}
        editorWorkId={editorWorkId}
        chatThreadId={chatThreadId}
        contextLive={contextLive}
        activeScheme={treeActiveScheme}
        activePath={treeActivePath}
        onSelectFile={handleSelectFile}
        paneRef={treePane}
        chats={
          <ChatsBody
            projectId={projectId}
            scopeWorkId={scope.workId}
            noWorkId={noWork?.id ?? null}
            currentThreadId={chatThreadId}
            onOpenChat={(threadId) => void chat.openChat(threadId)}
            onNewChat={() => void chat.openChatIndex()}
            onShowAllChats={() => void chat.openChatIndex()}
            onShowWork={scope.setWorkId}
          />
        }
      />
    </nav>
  );
}
