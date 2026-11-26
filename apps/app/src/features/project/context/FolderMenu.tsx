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

export type FolderMenuHost = {
  projectId: string;
  openDocument: (documentId: string) => void;
};

export const FolderMenuContext = createContext<FolderMenuHost | null>(null);

export function useFolderMenuHost(): FolderMenuHost | null {
  return useContext(FolderMenuContext);
}

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

export function FolderMenuBody({
  host,
  folderId,
  ...handlers
}: { host: FolderMenuHost; folderId: string } & MenuContentHandlers) {
  const { projectId } = host;
  const trees = useProjectTrees(projectId, { version: useTreeVersion() });
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
  const openAt = source.tree.trailInside(folderId);
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
