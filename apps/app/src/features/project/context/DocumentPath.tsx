/**
 * DocumentPath — the crumbs that say where an open document lives and take the
 * writer nearby. Every crumb opens the drill-in menu at the list it sits in,
 * with itself highlighted: the area among the areas, a folder in its parent,
 * the filename in its folder. The `…` that stands for folders that do not fit
 * opens where the last of them sits. No two crumbs open the same list.
 * Whatever lies on the document's path is highlighted at every level.
 *
 * The crumbs only navigate: a pick opens the document the way this screen
 * opens documents (`useOpenDocumentInDock`). Renaming and moving belong to the
 * lists. Folders collapse into `…` only when the row is too narrow for them,
 * measured from passive candidates of the same row renderer.
 */
import { t } from "@lingui/core/macro";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLineageTitle } from "@/client/query/useLineageTitle";
import { useProject } from "@/client/query/useProjectList";
import { useWorks } from "@/client/query/useWorks";
import { type ContextTab, tabContextOwner } from "@/client/stores";
import { DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDockBrowseScratch } from "../dock/use-dock-browse-scratch";
import { useOpenDocumentInDock } from "../dock/use-open-document-in-dock";
import { schemeIcon, schemeLabel } from "./context-schemes";
import type { TabLocation } from "./identity-location";
import { useProjectMenuSource } from "./use-catalog-menu-source";

/** Widest first: every folder, the last folder only, no folders, the area as its icon. */
type Fit = "all" | "last" | "none" | "icon";
const FITS: readonly Fit[] = ["all", "last", "none", "icon"];

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
  const rowRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const fit = useFit(rowRef, measureRef);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <span ref={rowRef} className="relative min-w-0 flex-1">
        <span
          ref={measureRef}
          aria-hidden
          inert
          className="pointer-events-none invisible absolute top-0 left-0"
        >
          {FITS.map((candidate) => (
            <CrumbRow key={candidate} fit={candidate} location={location} />
          ))}
        </span>
        <CrumbRow fit={fit} location={location} browse={{ projectId, tab }} />
      </span>
      {trailing}
    </span>
  );
}

type Browse = { projectId: string; tab: ContextTab };

/** Visible and intrinsic-width measurement rows share every layout decision. */
function CrumbRow({ fit, location, browse }: { fit: Fit; location: TabLocation; browse?: Browse }) {
  const { folders } = location;
  const SchemeIcon = schemeIcon(location.scheme);
  const area = schemeLabel(location.scheme);
  const shown = shownFolders(folders.length, fit);
  const hidden = folders.slice(0, folders.length - shown.length);
  const crumb = (
    key: string,
    label: ReactNode,
    depth: number,
    className?: string,
    tooltip?: string,
  ) => (
    <Crumb key={key} browse={browse} depth={depth} className={className} tooltip={tooltip}>
      {label}
    </Crumb>
  );
  return (
    <span className={cn("flex min-w-0 items-center gap-1 whitespace-nowrap", !browse && "w-max")}>
      {crumb(
        "area",
        <>
          <SchemeIcon aria-hidden className="size-3 shrink-0" />
          <span className={fit === "icon" ? "sr-only" : undefined}>{area}</span>
        </>,
        0,
        "shrink-0",
      )}
      {hidden.length > 0 ? (
        <>
          <Separator />
          {crumb("ellipsis", "…", hidden.length, "shrink-0", hidden.join(" › "))}
        </>
      ) : null}
      {shown.map((folderIndex) => (
        <span key={folderIndex} className="flex min-w-0 items-center gap-1">
          <Separator />
          {crumb(
            `folder:${folderIndex}`,
            <span className="truncate">{folders[folderIndex]}</span>,
            folderIndex + 1,
            "min-w-0",
          )}
        </span>
      ))}
      <Separator />
      {crumb(
        "leaf",
        <span className={cn("truncate", location.provisional && "italic")}>{location.leaf}</span>,
        folders.length + 1,
        "min-w-0 text-ink-muted",
      )}
    </span>
  );
}

function Separator() {
  return (
    <span aria-hidden className="shrink-0 opacity-60">
      ›
    </span>
  );
}

/** The folders still drawn by name at a fit, innermost last. */
export function shownFolders(count: number, fit: Fit): readonly number[] {
  if (fit === "all") return Array.from({ length: count }, (_, index) => index);
  if (fit === "last" && count > 0) return [count - 1];
  return [];
}

type PathMenu = {
  tree: Parameters<typeof DrillInMenu>[0]["tree"];
  hereIds: readonly string[];
  openAt: DrillNode[];
  onPick: (node: DrillNode) => void;
};

function Crumb({
  browse,
  depth,
  className,
  tooltip,
  children,
}: {
  browse?: Browse;
  depth: number;
  className?: string;
  tooltip?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const classes = cn("flex items-center gap-1 rounded-sm px-0.5", className);
  if (!browse || browse.tab.kind === "new") return <span className={classes}>{children}</span>;
  const button = (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => setOpen(true)}
      className={cn(
        classes,
        "focus-ring hover:bg-sidebar-accent/50 hover:text-foreground data-[state=open]:bg-sidebar-accent/50 data-[state=open]:text-foreground",
      )}
    >
      {children}
    </button>
  );
  const trigger = tooltip ? <TooltipTrigger asChild>{button}</TooltipTrigger> : button;
  const content = open ? (
    <OpenCrumbMenu
      browse={browse}
      depth={depth}
      onOpenChange={setOpen}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        requestAnimationFrame(() => buttonRef.current?.focus());
      }}
    >
      {trigger}
    </OpenCrumbMenu>
  ) : (
    trigger
  );
  return tooltip ? (
    <Tooltip>
      {content}
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  ) : (
    content
  );
}

/** Catalog observers exist only while browsing; the first menu mounts at its final trail. */
function OpenCrumbMenu({
  browse,
  depth,
  children,
  onOpenChange,
  onCloseAutoFocus,
}: {
  browse: Browse;
  depth: number;
  children: ReactElement;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const menu = useDocumentPathMenu(browse.projectId, browse.tab, depth);
  if (!menu) return children;
  return (
    <DrillInMenu
      tree={menu.tree}
      hereIds={menu.hereIds}
      openAt={menu.openAt}
      actions={() => []}
      onPick={menu.onPick}
      open
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {children}
    </DrillInMenu>
  );
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

/** Choose by actual candidate widths, not a second model of flex gaps or separators. */
function useFit(
  rowRef: React.RefObject<HTMLSpanElement | null>,
  measureRef: React.RefObject<HTMLSpanElement | null>,
): Fit {
  const [fit, setFit] = useState<Fit>("all");
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const candidates = Array.from(measure.children);
    const update = () => {
      const available = row.getBoundingClientRect().width;
      setFit(
        FITS.find((_, index) => candidates[index].getBoundingClientRect().width <= available) ??
          "icon",
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(row);
    for (const candidate of candidates) observer.observe(candidate);
    return () => observer.disconnect();
  }, [rowRef, measureRef]);
  return fit;
}
