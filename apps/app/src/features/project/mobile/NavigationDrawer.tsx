/**
 * NavigationDrawer — the phone project drawer: the Write | Chat switch, the sources, and the account.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { focusContentOnOpen, useDismissalFocus } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { TreeFile as ContextFile } from "@/core/project-tree/tree-view";
import { useOpenProjectDocument } from "../context/open-project-document";
import { TreeCreationProvider } from "../context/TreeCreationProvider";
import { InlineProjectTitle, type ProjectTitleEdit } from "../shell/InlineProjectTitle";
import { SourcesBody } from "../shell/sidebar/SourcesBody";
import { WorkScopePicker } from "../shell/sidebar/WorkScopePicker";
import { WorkspaceNavBody } from "../shell/WorkspaceNavBody";
import { useWorkScope } from "../use-work-scope";
import { useManageWorks } from "../work/ManageWorksDialog";

/** The drawer is the sidebar: there is nothing to expand. */
const keepOpen = () => {};

export type NavigationDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectTitle: string;
  titleEdit: ProjectTitleEdit;
  editorWorkId: string | null;
  contextLive: boolean;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  /** Who owns main's document when it is a Work's Scratch note. */
  activeContextWork: string | null;
  /** The chat on screen: its row reads as current. */
  chatThreadId: string | null;
};

export function NavigationDrawer({
  open,
  onOpenChange,
  projectId,
  projectTitle,
  titleEdit,
  editorWorkId,
  contextLive,
  activeContextScheme,
  activeContextPath,
  activeContextWork,
  chatThreadId,
}: NavigationDrawerProps) {
  const openDocument = useOpenProjectDocument(projectId);
  const scope = useWorkScope(projectId);
  const manageWorks = useManageWorks();
  const dismissal = useDismissalFocus(
    onOpenChange,
    // iOS Safari paints :focus-visible on Radix's programmatic focus of the first nav item.
    focusContentOnOpen,
  );
  const handleSelectFile = (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => {
    void openDocument({
      documentId: file.documentId,
      known: { scheme, file, workId: editorWorkId },
      workId: editorWorkId ?? undefined,
      ...options,
    }).then((result) => {
      if (result.kind === "committed") onOpenChange(false);
    });
  };
  return (
    <Sheet open={open} onOpenChange={dismissal.onOpenChange}>
      <SheetContent
        side="left"
        showCloseButton={false}
        {...dismissal.content}
        // Width leaves a >=56px scrim tap target on small phones (375px ->
        // 319px drawer); 320px cap matches standard mobile nav-drawer sizing.
        // The animated SheetContent stays visually bare (transparent, no
        // radius/clip/shadow): WebKit has a compositing bug where
        // overflow:hidden + border-radius on a transform-animated element drops
        // child content (blank rects) while rasterizing during the slide. All
        // drawer chrome lives on the full-size inner wrapper below instead.
        className="w-[85vw] max-w-[320px] gap-0 border-r-0 bg-transparent p-0 text-foreground shadow-none"
      >
        <SheetTitle className="visually-hidden">
          <Trans>Workspace navigation</Trans>
        </SheetTitle>
        <SheetDescription className="visually-hidden">
          <Trans>Switch screens or manage your account.</Trans>
        </SheetDescription>
        {/* Chrome wrapper — rounded-r-xl + shadow-modal carry the desktop
            rail chrome (desktop-layout.ts) instead of a hairline border. It is
            NOT the animated element (see WebKit note above), so it can safely
            clip; safe-area paddings live here so the drawer background still
            fills under the notch/home-indicator regions. */}
        <div
          className="flex h-full min-h-0 flex-col overflow-hidden rounded-r-xl bg-chrome shadow-modal"
          style={{
            paddingTop: "env(safe-area-inset-top)",
            paddingLeft: "env(safe-area-inset-left)",
            paddingRight: "env(safe-area-inset-right)",
          }}
        >
          <nav aria-label={t`Workspace navigation`} className="flex h-full min-h-0 flex-col">
            <div className="flex h-12 shrink-0 items-center border-b border-border-subtle px-3">
              <InlineProjectTitle
                title={projectTitle}
                {...titleEdit}
                showRenameHint
                className="focus-ring flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-semibold hover:bg-ink-fill"
                inputClassName="min-h-11 px-2 text-sm font-semibold"
              />
            </div>

            {/* The switch moves main and closes the drawer onto it, as a pick in a list does. */}
            <WorkspaceNavBody projectId={projectId} onSwitched={() => onOpenChange(false)}>
              {/* The drawer's own creation seam: closing the drawer unmounts it, ending any inline create. */}
              <TreeCreationProvider expandSidebar={keepOpen}>
                <div className="flex shrink-0 flex-col py-1">
                  <WorkScopePicker
                    projectId={projectId}
                    workId={scope.workId}
                    onPick={scope.setWorkId}
                    onManage={() => {
                      manageWorks?.open();
                      onOpenChange(false);
                    }}
                  />
                </div>
                <SourcesBody
                  projectId={projectId}
                  editorWorkId={editorWorkId}
                  chatThreadId={chatThreadId}
                  contextLive={contextLive}
                  activeScheme={activeContextScheme}
                  activePath={activeContextPath}
                  activeWorkId={activeContextWork}
                  onSelectFile={handleSelectFile}
                  scopeWorkId={scope.workId}
                  onPicked={() => onOpenChange(false)}
                />
              </TreeCreationProvider>
            </WorkspaceNavBody>
          </nav>
        </div>
      </SheetContent>
    </Sheet>
  );
}
