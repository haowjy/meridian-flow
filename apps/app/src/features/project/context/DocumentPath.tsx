/**
 * DocumentPath — the crumbs that say where an open document lives and take the
 * writer nearby. Every crumb opens the drill-in menu inside the place it names:
 * the area, a folder, or (for the filename) the folder that holds it. The `…`
 * that stands for folders that do not fit opens one level above the crumb after
 * it. Whatever lies on the document's path is highlighted at every level.
 *
 * The crumbs only navigate: a pick opens the document the way this screen
 * opens documents (`useOpenDocumentInDock`). Renaming and moving belong to the
 * lists. Folders collapse into `…` only when the row is too narrow for them,
 * measured from a hidden copy of the full row.
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
  /** What follows the path on its row (a link-update note); the path fits around it. */
  trailing?: ReactNode;
}) {
  const menu = useDocumentPathMenu(projectId, tab);
  const { folders } = location;
  const rowRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const trailingRef = useRef<HTMLSpanElement>(null);
  const fit = useFit(rowRef, measureRef, trailingRef, folders.length);

  const SchemeIcon = schemeIcon(location.scheme);
  const area = schemeLabel(location.scheme);
  // The menu trail each crumb opens inside: the area, then one folder per step.
  const trailTo = (depth: number) => menu?.openAt.slice(0, depth + 1) ?? null;
  const shown = shownFolders(folders.length, fit);
  const hidden = folders.slice(0, folders.length - shown.length);

  const crumb = (
    key: string,
    label: ReactNode,
    trail: DrillNode[] | null,
    className?: string,
    tooltip?: string,
  ) => (
    <Crumb
      key={key}
      menu={trail && menu ? { ...menu, openAt: trail } : null}
      className={className}
      tooltip={tooltip}
    >
      {label}
    </Crumb>
  );
  const areaLabel = (iconOnly: boolean) => (
    <>
      <SchemeIcon aria-hidden className="size-3 shrink-0" />
      {iconOnly ? <span className="sr-only">{area}</span> : <span>{area}</span>}
    </>
  );

  return (
    <span ref={rowRef} className="relative flex min-w-0 flex-1 items-center gap-1">
      {/* The full row, invisible, for measuring what fits. */}
      <span
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-1 whitespace-nowrap"
      >
        <span data-measure="area" className="flex items-center gap-1 px-0.5">
          {areaLabel(false)}
        </span>
        <span data-measure="icon" className="flex items-center px-0.5">
          <SchemeIcon className="size-3" />
        </span>
        <span data-measure="sep">›</span>
        <span data-measure="ellipsis" className="px-0.5">
          …
        </span>
        {folders.map((folder, index) => (
          <span key={`${index}:${folder}`} data-measure="folder" className="px-0.5">
            {folder}
          </span>
        ))}
        <span data-measure="leaf" className="px-0.5">
          {location.leaf}
        </span>
      </span>

      {crumb("area", areaLabel(fit === "icon"), trailTo(0), "shrink-0")}
      {hidden.length > 0 ? (
        <>
          <Separator />
          {/* One level above the crumb after it: inside the folder that holds the last folder. */}
          {crumb("ellipsis", "…", trailTo(folders.length - 1), "shrink-0", hidden.join(" › "))}
        </>
      ) : null}
      {shown.map((folderIndex) => {
        const folder = folders[folderIndex];
        const depth = folderIndex + 1;
        return (
          <span key={`${depth}:${folder}`} className="flex min-w-0 items-center gap-1">
            <Separator />
            {crumb(
              `folder:${depth}`,
              <span className="truncate">{folder}</span>,
              trailTo(depth),
              "min-w-0",
            )}
          </span>
        );
      })}
      <Separator />
      {crumb(
        "leaf",
        <span className={cn("truncate", location.provisional && "italic")}>{location.leaf}</span>,
        trailTo(folders.length),
        "min-w-0 text-ink-muted",
      )}
      {trailing ? (
        <span ref={trailingRef} className="flex shrink-0 items-center">
          {trailing}
        </span>
      ) : null}
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
function shownFolders(count: number, fit: Fit): readonly number[] {
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
  menu,
  className,
  tooltip,
  children,
}: {
  menu: PathMenu | null;
  className?: string;
  /** What the crumb stands for, when its label does not say (the `…`). */
  tooltip?: string;
  children: ReactNode;
}) {
  const classes = cn("flex items-center gap-1 rounded-sm px-0.5", className);
  // A document not yet in a catalog (an untitled draft) has nowhere to browse from.
  if (!menu) return <span className={classes}>{children}</span>;
  const button: ReactElement = (
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
  const crumbMenu = (
    <DrillInMenu
      tree={menu.tree}
      hereIds={menu.hereIds}
      openAt={menu.openAt}
      actions={[]}
      onPick={menu.onPick}
    >
      {tooltip ? <TooltipTrigger asChild>{button}</TooltipTrigger> : button}
    </DrillInMenu>
  );
  if (!tooltip) return crumbMenu;
  return (
    <Tooltip>
      {crumbMenu}
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** The project menu a document's crumbs browse, opened along the document's own path. */
function useDocumentPathMenu(projectId: string, tab: ContextTab): PathMenu | null {
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
    openAt,
    onPick,
  };
}

/** The widest fit whose crumbs fit the row, re-measured when the row resizes. */
function useFit(
  rowRef: React.RefObject<HTMLSpanElement | null>,
  measureRef: React.RefObject<HTMLSpanElement | null>,
  trailingRef: React.RefObject<HTMLSpanElement | null>,
  folderCount: number,
): Fit {
  const [fit, setFit] = useState<Fit>("all");
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const width = (name: string) =>
      Array.from(measure.querySelectorAll<HTMLElement>(`[data-measure="${name}"]`)).map(
        (element) => element.getBoundingClientRect().width,
      );
    const update = () => {
      const gap = 4;
      const [area = 0] = width("area");
      const [icon = 0] = width("icon");
      const [sep = 0] = width("sep");
      const [ellipsis = 0] = width("ellipsis");
      const [leaf = 0] = width("leaf");
      const folders = width("folder");
      const step = (w: number) => sep + w + gap * 2;
      const total = (choice: Fit) => {
        const shown = shownFolders(folderCount, choice).map((index) => folders[index] ?? 0);
        const hasEllipsis = folderCount > shown.length;
        return (
          (choice === "icon" ? icon : area) +
          (hasEllipsis ? step(ellipsis) : 0) +
          shown.reduce((sum, w) => sum + step(w), 0) +
          step(leaf)
        );
      };
      const trailing = trailingRef.current?.getBoundingClientRect().width ?? 0;
      const available = row.getBoundingClientRect().width - (trailing ? trailing + gap : 0);
      setFit(FITS.find((choice) => choice === "icon" || total(choice) <= available) ?? "icon");
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(row);
    observer.observe(measure);
    if (trailingRef.current) observer.observe(trailingRef.current);
    return () => observer.disconnect();
  }, [rowRef, measureRef, trailingRef, folderCount]);
  return fit;
}
