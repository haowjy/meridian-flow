/**
 * The menu a folder chip opens: the path crumbs' drill-in menu, opened inside
 * the folder. Subfolders drill, Back climbs, and a document opens the way the
 * chip's surface opens documents.
 *
 * Opened by identity. The folder is found in the catalogs the menu already
 * holds; otherwise the stable-ID lookup says where it lives now (it may be
 * another Work's Scratch), and that area's catalog is acquired. Both happen
 * only while the menu is open, so a transcript full of folder chips costs
 * nothing until one is clicked.
 */
import { t } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import {
  type CatalogFolderEntry,
  type CatalogScope,
  contextOwner,
} from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  type ComponentPropsWithoutRef,
  createContext,
  forwardRef,
  type ReactElement,
  useContext,
  useMemo,
} from "react";
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useProject } from "@/client/query/useProjectList";
import { DrillInMenuBody, DrillInMenuRoot, type DrillNode } from "@/components/app/DrillInMenu";
import { DropdownMenuContent, type DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useDockBrowseScratch } from "../dock/use-dock-browse-scratch";
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
  const lookup = useQuery({
    queryKey: projectQueryKeys.folderIdentity(projectId, folderId),
    queryFn: ({ signal }) => lookupProjectContextAvailability(projectId, [], signal, [folderId]),
    // Where the folder is now: a rename or move since the last open must not reopen the old place.
    staleTime: 0,
  });
  const resolution = lookup.data?.folderResolutions?.[0];
  const found = resolution?.kind === "available" ? resolution.entry : null;
  const own = useMemo(() => (found ? ownArea(found) : null), [found]);
  const heading = useOwnAreaHeading(projectId, own);
  const title = useProject(projectId)?.title ?? "";
  const scratch = useDockBrowseScratch(projectId);
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
  const kind = resolution?.kind;
  const failed = lookup.isError || kind === "indeterminate";
  const gone = kind === "deleted" || kind === "not-visible" || kind === "authority-unavailable";
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

/** The area a folder lives in, as the menu source names areas. */
function ownArea(entry: CatalogFolderEntry) {
  const parsed = parseContextUri(entry.uri);
  if (!parsed.ok) return null;
  return { scheme: parsed.value.scheme, owner: scopeOwner(entry.scope) };
}

function scopeOwner(scope: CatalogScope) {
  switch (scope.kind) {
    case "work":
      return contextOwner(scope.workId);
    case "lineage":
      return contextOwner(null, scope.rootThreadId);
    case "chat":
      return contextOwner(null, null, scope.chatId);
    default:
      return contextOwner(null);
  }
}
