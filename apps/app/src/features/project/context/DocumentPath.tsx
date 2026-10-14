/**
 * DocumentPath — the crumbs that say where an open document lives and take the
 * writer nearby. Every crumb opens the drill-in menu at the list it sits in,
 * with itself highlighted: the area among the areas, a folder in its parent,
 * the filename in its folder. No two crumbs open the same list.
 * Whatever lies on the document's path is highlighted at every level.
 *
 * The crumbs only navigate: a pick opens the document the way this screen
 * opens documents (`useOpenDocumentInDock`). Renaming and moving belong to the
 * lists. The identity row owns collapse priority; parent crumbs yield before controls.
 */
import { t } from "@lingui/core/macro";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { useLineageTitle } from "@/client/query/useLineageTitle";
import { useProject } from "@/client/query/useProjectList";
import { useWorks } from "@/client/query/useWorks";
import { type ContextTab, tabContextOwner } from "@/client/stores";
import { DrillInMenuBody, DrillInMenuRoot, type DrillNode } from "@/components/app/DrillInMenu";
import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useDockBrowseScratch } from "../dock/use-dock-browse-scratch";
import { useOpenDocumentInDock } from "../dock/use-open-document-in-dock";
import { schemeIcon, schemeLabel } from "./context-schemes";
import type { TabLocation } from "./identity-location";
import { useProjectMenuSource } from "./use-catalog-menu-source";

export function DocumentPath({
  projectId,
  tab,
  location,
  trailing,
}: {
  projectId: string;
  tab: ContextTab;
  location: TabLocation;
  /** Rendered directly so a note returning null leaves no empty flex item. */
  trailing?: ReactNode;
}) {
  return (
    <span data-identity-path className="flex min-w-16 items-center gap-1">
      <CrumbRow location={location} browse={{ projectId, tab }} />
      {trailing}
    </span>
  );
}

type Browse = { projectId: string; tab: ContextTab };

/** Parent crumbs yield as one group; the leaf remains a usable navigation target. */
function CrumbRow({ location, browse }: { location: TabLocation; browse: Browse }) {
  const { folders } = location;
  const SchemeIcon = schemeIcon(location.scheme);
  const area = schemeLabel(location.scheme);
  const crumb = (key: string, label: ReactNode, depth: number, className?: string) => (
    <Crumb key={key} browse={browse} depth={depth} className={className}>
      {label}
    </Crumb>
  );
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1 whitespace-nowrap">
      <span data-path-parents className="flex shrink-0 items-center gap-1">
        {crumb(
          "area",
          <>
            <SchemeIcon aria-hidden className="size-3 shrink-0" />
            <span>{area}</span>
          </>,
          0,
          "shrink-0",
        )}
        {folders.map((folder, folderIndex) => (
          <span key={folderIndex} className="flex min-w-0 items-center gap-1">
            <Separator />
            {crumb(
              `folder:${folderIndex}`,
              <span className="truncate">{folder}</span>,
              folderIndex + 1,
              "min-w-0",
            )}
          </span>
        ))}
        <Separator />
      </span>
      {crumb(
        "leaf",
        <span data-path-leaf className={cn("truncate", location.provisional && "italic")}>
          {location.leaf}
        </span>,
        folders.length + 1,
        "min-w-16 flex-1 text-ink-muted",
      )}
    </span>
  );
}

function Separator() {
  return <ChevronRight aria-hidden className="size-3 shrink-0 opacity-60" />;
}

type PathMenu = {
  tree: Parameters<typeof DrillInMenuBody>[0]["tree"];
  hereIds: readonly string[];
  openAt: DrillNode[];
  onPick: (node: DrillNode) => void;
};

function Crumb({
  browse,
  depth,
  className,
  children,
}: {
  browse: Browse;
  depth: number;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn("flex items-center gap-1 rounded-sm px-0.5", className);
  if (browse.tab.kind === "new") return <span className={classes}>{children}</span>;
  const button = (
    <button
      type="button"
      className={cn(
        classes,
        "focus-ring hover:bg-sidebar-accent/50 hover:text-foreground data-[state=open]:bg-sidebar-accent/50 data-[state=open]:text-foreground",
      )}
    >
      {children}
    </button>
  );
  return (
    <DrillInMenuRoot body={<OpenCrumbMenu browse={browse} depth={depth} />}>
      {button}
    </DrillInMenuRoot>
  );
}

/** Acquisition is inside the open boundary; no placeholder tree can flash a wrong level. */
function OpenCrumbMenu({ browse, depth }: { browse: Browse; depth: number }) {
  const menu = useDocumentPathMenu(browse.projectId, browse.tab, depth);
  if (!menu)
    return (
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-1rem)]">
        <p className="px-2 py-1.5 text-sm text-muted-foreground">{t`Loading…`}</p>
      </DropdownMenuContent>
    );
  return <DrillInMenuBody {...menu} />;
}

/** The project menu a document's crumbs browse, opened along the document's own path. */
function useDocumentPathMenu(projectId: string, tab: ContextTab, depth: number): PathMenu | null {
  const locatedTab = tab.kind === "new" ? null : tab;
  const openDocument = useOpenDocumentInDock();
  const { works } = useWorks(projectId);
  const work = locatedTab?.workId
    ? works?.find((candidate) => candidate.id === locatedTab.workId)
    : undefined;
  // A document's owner names its own area: the Work, or the chat whose Scratch it is.
  const lineageTitle = useLineageTitle(
    projectId,
    locatedTab?.rootThreadId ? { rootThreadId: locatedTab.rootThreadId } : null,
  );
  const ownerName = work?.name ?? lineageTitle;
  const heading = !locatedTab
    ? ""
    : ownerName
      ? t`${schemeLabel(locatedTab.scheme)} for ${ownerName}`
      : schemeLabel(locatedTab.scheme);
  // The Scratch at the menu's root is the one on screen; the document's own area is separate.
  const scratch = useDockBrowseScratch(projectId);
  const project = useProject(projectId);
  const source = useProjectMenuSource({
    projectId,
    title: project?.title ?? "",
    scratch,
    document: locatedTab
      ? { scheme: locatedTab.scheme, owner: tabContextOwner(locatedTab), heading }
      : null,
  });
  const current = locatedTab
    ? (source.own.catalog?.findDocument(locatedTab.documentId) ?? null)
    : null;
  const openAt = useMemo(
    () => (locatedTab ? source.own.openAt(locatedTab.path) : []),
    [source.own, locatedTab],
  );
  const onPick = useCallback(
    (node: DrillNode) => {
      const next = source.tabFor(node.id);
      if (next) openDocument(next);
    },
    [openDocument, source],
  );
  if (!locatedTab || !current || openAt.length === 0) return null;
  return {
    tree: source.tree,
    hereIds: [...openAt.map((node) => node.id), current.entryId],
    openAt: source.own.crumbTrail(locatedTab.path, depth),
    onPick,
  };
}
