/**
 * The menu a folder chip opens: the path crumbs' drill-in menu, opened inside
 * the folder. Subfolders drill, Back climbs, and a document opens the way the
 * chip's surface opens documents.
 *
 * Opened by identity. The project's replay says where the folder lives now (it may be
 * another Work's Scratch), a rename or move made a moment ago included. That is read
 * only while the menu is open, so a transcript full of folder chips costs nothing
 * until one is clicked.
 */

import { t } from "@lingui/core/macro";
import {
  type ComponentPropsWithoutRef,
  createContext,
  forwardRef,
  type ReactElement,
  useContext,
  useMemo,
} from "react";
import { useProject } from "@/client/query/useProjectList";
import { ownerOfSource, useProjectTrees } from "@/client/query/useProjectTrees";
import { DrillInMenuBody, DrillInMenuRoot, type DrillNode } from "@/components/app/DrillInMenu";
import { DropdownMenuContent, type DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTreeVersion } from "@/core/project-tree/tree-version";
import { useOnScreenChatScratchSource } from "../chat/use-chat-scratch-source";
import { useOwnAreaHeading, useProjectMenuSource } from "./use-project-menu-source";

/** What a surface's folder chips need: the project, and how that surface opens a document. */
export type FolderMenuHost = {
  projectId: string;
  openDocument: (documentId: string) => void;
};

/** Provided by each surface that shows folder chips; without one a folder chip opens nothing. */
export const FolderMenuContext = createContext<FolderMenuHost | null>(null);

export function useFolderMenuHost(): FolderMenuHost | null {
  return useContext(FolderMenuContext);
}

/** Wraps a folder chip: pressing it opens the menu inside the folder. */
type FolderMenuProps = {
  host: FolderMenuHost;
  folderId: string;
  children: ReactElement;
} & Omit<ComponentPropsWithoutRef<typeof DropdownMenuTrigger>, "asChild">;

export const FolderMenu = forwardRef<HTMLButtonElement, FolderMenuProps>(function FolderMenu(
  { host, folderId, children, ...triggerProps },
  ref,
) {
  return (
    <DrillInMenuRoot
      body={<FolderMenuBody host={host} folderId={folderId} />}
      triggerProps={triggerProps}
      triggerRef={ref}
    >
      {children}
    </DrillInMenuRoot>
  );
});

type MenuContentHandlers = {
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
};

/** The open menu's content, for a host that owns its own `DropdownMenu` (the Editor's pointer anchor). */
export function FolderMenuBody({
  host,
  folderId,
  ...handlers
}: { host: FolderMenuHost; folderId: string } & MenuContentHandlers) {
  const { projectId } = host;
  const trees = useProjectTrees(projectId, { account: true, version: useTreeVersion() });
  const own = useMemo(() => {
    for (const source of trees.sources)
      if (trees.tree(source.id)?.entry(folderId))
        return { scheme: source.scheme, owner: ownerOfSource(source) };
    return null;
  }, [trees, folderId]);
  const heading = useOwnAreaHeading(projectId, own);
  const title = useProject(projectId)?.title ?? "";
  const scratch = useOnScreenChatScratchSource(projectId);
  const source = useProjectMenuSource({
    projectId,
    title,
    scratch,
    own: own ? { ...own, heading } : null,
  });
  // A catalog already on hand opens the menu at once; the lookup only has to answer for the rest.
  const openAt = source.trailInside(folderId);
  if (openAt) {
    const onPick = (node: DrillNode) => host.openDocument(node.documentId ?? node.id);
    return (
      <DrillInMenuBody
        tree={source.tree}
        hereIds={openAt.map((node) => node.id)}
        openAt={openAt}
        onPick={onPick}
        {...handlers}
      />
    );
  }
  const failed = trees.isError;
  const gone = trees.isComplete && !own;
  return (
    <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-1rem)]" {...handlers}>
      <p
        role={failed || gone ? "alert" : "status"}
        className="px-2 py-1.5 text-sm text-muted-foreground"
      >
        {failed
          ? t`Couldn't open this folder.`
          : gone
            ? t`This folder is no longer available.`
            : t`Loading…`}
      </p>
    </DropdownMenuContent>
  );
}
