/**
 * LeftSidebar — the desktop project sidebar. The header holds the project menu,
 * then the Work scope, then the mode switch. The body follows the mode: sources
 * in Write, chats in Chat. Both bodies stay mounted (the hidden one inert), so
 * tree expansion and scroll survive a mode switch. The phone drawer composes
 * `WorkspaceNavBody` instead.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Trash2 } from "lucide-react";
import { useRef } from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { useWorks } from "@/client/query/useWorks";
import { AccountMenu } from "@/features/account/AccountMenu";
import { UserRailSection } from "../context/ContextTreePanel";
import { useOpenProjectDocument } from "../context/open-project-document";
import { useDockDocument } from "../dock/dock-document-store";
import { useDockDocumentTab } from "../dock/use-dock-document-tab";
import { modeOf } from "../layout/placement";
import { useChatNavigation } from "../routing/chat-navigation";
import { useProjectTrashNavigation, useScreenCommands } from "../routing/ProjectNavigationContext";
import { InlineProjectTitle, type ProjectTitleEdit } from "./InlineProjectTitle";
import { PanelToggleSpacer } from "./PanelToggleButton";
import { ProjectMenu } from "./ProjectMenu";
import type { ScreenKey } from "./screens";
import { ChatsBody } from "./sidebar/ChatsBody";
import { ModeSwitch } from "./sidebar/ModeSwitch";
import { MODES } from "./sidebar/modes";
import { SourcesBody } from "./sidebar/SourcesBody";
import { useWorkScope } from "./sidebar/use-work-scope-stub";
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
  const trashNavigation = useProjectTrashNavigation();
  const screenCommands = useScreenCommands();
  const chat = useChatNavigation();
  const titleEditor = useRef<TitleEditHandle>(null);
  const treePane = useRef<HTMLDivElement>(null);
  const openDocument = useOpenProjectDocument(projectId);
  const { noWork } = useWorks(projectId);
  const scope = useWorkScope(projectId, editorWorkId ?? noWork?.id ?? null);
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
  const dockDocument = useDockDocument(activeScreen, projectId);
  const projectedDock = useDockDocumentTab(projectId, dockDocument);
  const docked = activeScreen === "chat" && !projectedDock.gone ? projectedDock.tab : null;
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
          const entry = MODES.find((candidate) => candidate.key === next);
          if (entry && next !== mode) onSelectScreen(entry.screen);
        }}
      />

      <div
        className="flex min-h-0 flex-1 flex-col"
        hidden={mode !== "write"}
        inert={mode !== "write"}
      >
        <SourcesBody
          projectId={projectId}
          editorWorkId={editorWorkId}
          chatThreadId={chatThreadId}
          contextLive={contextLive}
          activeScheme={treeActiveScheme}
          activePath={treeActivePath}
          onSelectFile={handleSelectFile}
          paneRef={treePane}
        />
        {contextLive ? (
          <UserRailSection
            projectId={projectId}
            editorWorkId={editorWorkId}
            activeScheme={treeActiveScheme}
            activePath={treeActivePath}
            onSelectFile={handleSelectFile}
            resizeAgainst={treePane}
          />
        ) : null}
        <div className="shrink-0 px-2">
          <button
            type="button"
            onClick={() => void trashNavigation.navigate(true)}
            className="focus-ring flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-ink-muted hover:bg-sidebar-accent/50 hover:text-foreground"
          >
            <Trash2 className="size-4 shrink-0" aria-hidden />
            <Trans>Trash</Trans>
          </button>
        </div>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col"
        hidden={mode !== "chat"}
        inert={mode !== "chat"}
      >
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
      </div>

      <div className="shrink-0 border-t border-border-subtle px-2 py-1.5">
        <AccountMenu />
      </div>
    </nav>
  );
}
