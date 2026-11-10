/**
 * LeftSidebar — the desktop project sidebar. The header holds the project menu,
 * then the Work scope, then the mode switch. Under the switch sits the mode's
 * own sidebar (`MODE_SIDEBARS`). The phone drawer has no mode switch: it
 * composes `WorkspaceNavBody` instead.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useRef } from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { useSelectedContextTab } from "@/client/stores";
import { AccountMenu } from "@/features/account/AccountMenu";
import { cn } from "@/lib/utils";
import { useAccountResourceProjection } from "../context/account-feature-context";
import { sidebarRole } from "../context/context-row-geometry";
import { projectResourceTab } from "../context/context-tab-from-file";
import { useOpenProjectDocument } from "../context/open-project-document";
import { modeMeta } from "../layout/modes";
import { modeOf } from "../layout/placement";
import { useWorkScope } from "../use-work-scope";
import { useManageWorks } from "../work/ManageWorksDialog";
import { InlineProjectTitle, type ProjectTitleEdit } from "./InlineProjectTitle";
import { PanelToggleSpacer } from "./PanelToggleButton";
import { ProjectMenu } from "./ProjectMenu";
import type { ScreenKey } from "./screens";
import { ModeSwitch } from "./sidebar/ModeSwitch";
import { MODE_SIDEBARS } from "./sidebar/mode-sidebars";
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
  const manageWorks = useManageWorks();
  const titleEditor = useRef<TitleEditHandle>(null);
  const openDocument = useOpenProjectDocument(projectId);
  const scope = useWorkScope(projectId);
  const mode = modeOf(activeScreen);
  const Sidebar = MODE_SIDEBARS[mode];

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
          className={cn(
            "focus-ring flex h-8 min-w-0 flex-1 cursor-default items-center rounded-md px-2 text-left font-semibold",
            sidebarRole.row,
            sidebarRole.hover,
          )}
          inputClassName={cn("h-8 px-2 font-semibold", sidebarRole.row)}
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
        onManage={() => manageWorks?.open()}
      />
      <ModeSwitch
        mode={mode}
        onSelect={(next) => {
          if (next !== mode) onSelectScreen(modeMeta(next).screen);
        }}
      />
      <Sidebar
        projectId={projectId}
        editorWorkId={editorWorkId}
        chatThreadId={chatThreadId}
        contextLive={contextLive}
        activeScheme={treeActiveScheme}
        activePath={treeActivePath}
        onSelectFile={handleSelectFile}
        scopeWorkId={scope.workId}
        onShowWork={scope.setWorkId}
      />
    </nav>
  );
}
