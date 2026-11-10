import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { ListChecks, type LucideIcon, Plus, Trash2 } from "lucide-react";
import {
  type ComponentType,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { Chip } from "@/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { role } from "@/components/ui/roles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { destinationOf } from "@/features/import/destination";
import { useOptionalImports } from "@/features/import/ImportProvider";
import { cn } from "@/lib/utils";
import { ScratchSource, useChatScratch } from "../../chat/ChatScratch";
import { type CatalogState, ContextTreePanel } from "../../context/ContextTreePanel";
import { sidebarIcon } from "../../context/context-row-geometry";
import { EDITOR_CONTEXT_SCHEMES, schemeIcon, schemeLabel } from "../../context/context-schemes";
import type { MoveArea } from "../../context/entry-drag/move-plan";
import { EntryList, useEntryList } from "../../context/entry-drag/use-entry-list";
import { useOptionalTreeCreation } from "../../context/TreeCreationProvider";
import { type FilesRoute, useTreeDropTarget } from "../../context/tree-drop/tree-drop";
import { type ChangesScope, ChangesSource, useChangesScope } from "./ChangesSource";
import type { SourceDrop } from "./SourcePane";
import { ALL_SOURCES, type SourceKey, useSidebarTabs } from "./sidebar-tabs-store";
import { TrashSource } from "./TrashSource";
import { useTrashDrop } from "./trash-drop";

type TreeKey = (typeof EDITOR_CONTEXT_SCHEMES)[number];

type WriteSources = {
  projectId: string;
  /** Shell-resolved Editor Work; the tree never derives scope from Chat. */
  editorWorkId: string | null;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  onSelectFile: (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => void;
  /** After a pick that opens something elsewhere (the phone drawer closes). */
  onPicked?: () => void;
  catalogs: Record<TreeKey, CatalogState>;
  scratch: ReturnType<typeof useChatScratch>;
  changes: ChangesScope;
};

const WriteSourcesContext = createContext<WriteSources | null>(null);

function useWriteSources(): WriteSources {
  const sources = useContext(WriteSourcesContext);
  if (!sources) throw new Error("A source needs SourcesBody");
  return sources;
}

/**
 * One sidebar source. `useDrop` is the drop at the source's root, used by its
 * tab (where `reveal` shows the source) and by its pane; `Body` is its pane.
 */
type Source = {
  label: () => string;
  /** The tab's name when it says more than the label (whose changes). */
  title?: (sources: WriteSources) => string;
  /** A count on the tab of what waits on the writer; 0 shows none. */
  badge?: (sources: WriteSources) => number;
  icon: LucideIcon;
  useDrop: (reveal?: () => void) => SourceDrop;
  Body: ComponentType<{ drop: SourceDrop }>;
};

/** A drop at a catalog's top level; a drag resting on it accepted shows the source. */
function useRootDrop(scheme: TreeKey | "scratch", reveal?: () => void): SourceDrop {
  const { catalogs, scratch } = useWriteSources();
  const catalog = scheme === "scratch" ? scratch.primary.catalog : catalogs[scheme].catalog;
  const rootId = catalog?.root.entryId ?? null;
  const target = useMemo(
    () => ({ scheme, catalogRootId: rootId ?? `${scheme}:loading`, folder: null }),
    [scheme, rootId],
  );
  return useTreeDropTarget(target, { reveal });
}

function treeSource(scheme: TreeKey): Source {
  return {
    label: () => schemeLabel(scheme),
    icon: schemeIcon(scheme),
    useDrop: (reveal) => useRootDrop(scheme, reveal),
    Body: ({ drop }) => {
      const sources = useWriteSources();
      return (
        <ContextTreePanel
          scheme={scheme}
          catalogState={sources.catalogs[scheme]}
          projectId={sources.projectId}
          editorWorkId={sources.editorWorkId}
          activeScheme={sources.activeScheme}
          activePath={sources.activePath}
          onSelectFile={sources.onSelectFile}
          drop={drop}
        />
      );
    },
  };
}

const SOURCES: Record<SourceKey, Source> = {
  manuscript: treeSource("manuscript"),
  kb: treeSource("kb"),
  user: treeSource("user"),
  unfiled: treeSource("unfiled"),
  scratch: {
    label: () => schemeLabel("scratch"),
    icon: schemeIcon("scratch"),
    useDrop: (reveal) => useRootDrop("scratch", reveal),
    Body: ({ drop }) => {
      const { projectId, scratch, onPicked } = useWriteSources();
      return (
        <ScratchSource projectId={projectId} scratch={scratch} onPicked={onPicked} drop={drop} />
      );
    },
  },
  trash: {
    label: () => t`Trash`,
    icon: Trash2,
    // Dropping deletes, so the drag needs no look at Trash first.
    useDrop: () => useTrashDrop(useWriteSources().projectId),
    Body: ({ drop }) => {
      const { projectId, onPicked } = useWriteSources();
      return <TrashSource projectId={projectId} onPicked={onPicked} drop={drop} />;
    },
  },
  changes: {
    label: () => t`Changes`,
    title: ({ changes }) => changes.heading,
    badge: ({ changes }) => changes.count,
    icon: ListChecks,
    useDrop: () => IDLE_DROP,
    Body: () => {
      const { projectId, changes, activeScheme, activePath, onPicked } = useWriteSources();
      return (
        <ChangesSource
          projectId={projectId}
          scope={changes}
          isOpen={(file) =>
            file.contextLocation?.scheme === activeScheme &&
            file.contextLocation?.path === activePath
          }
          onPicked={onPicked}
        />
      );
    },
  },
};

/** A source nothing is dropped on. */
const IDLE_DROP: SourceDrop = { dropProps: {}, dropState: "idle" };

function isSourceKey(key: string): key is SourceKey {
  return Object.hasOwn(SOURCES, key);
}

/**
 * Write mode's sidebar, and the phone drawer's: one source at a time behind a
 * strip of tabs, so each list gets the full height. Tabs are icons named on
 * hover; the list names its source. + picks which tabs the strip shows. The
 * open document's source becomes the shown one when it changes, unless Changes is shown. The strip and
 * every source are one list: one selection, and a row dragged anywhere in the
 * sidebar drops on any tab or pane.
 */
export function SourcesBody({
  projectId,
  editorWorkId,
  chatThreadId,
  contextLive,
  activeScheme,
  activePath,
  onSelectFile,
  onPicked,
}: Omit<WriteSources, "catalogs" | "scratch" | "changes"> & {
  chatThreadId: string | null;
  contextLive: boolean;
}) {
  const chosen = useSidebarTabs((state) => state.shown);
  useEffect(() => {
    void useSidebarTabs.persist.rehydrate();
  }, []);
  const [picked, setPicked] = useState<SourceKey>("manuscript");
  // Changes stays: it is the list the writer opens drafts from, whatever tree they live in.
  useEffect(() => {
    if (activeScheme && isSourceKey(activeScheme))
      setPicked((current) => (current === "changes" ? current : activeScheme));
  }, [activeScheme]);
  // A new file or folder asked for elsewhere (the empty Editor) appears in its source.
  const creatingScheme = useOptionalTreeCreation()?.request?.scheme;
  useEffect(() => {
    if (creatingScheme && isSourceKey(creatingScheme)) setPicked(creatingScheme);
  }, [creatingScheme]);
  const changes = useChangesScope(projectId, chatThreadId);
  // Under None, Changes is offered only while the chat on screen has drafts, but it stays
  // while it is the pane on show, so emptying it keeps the last command's Undo in view.
  const shown = useMemo(
    () => chosen.filter((key) => key !== "changes" || changes.offered || picked === "changes"),
    [chosen, changes.offered, picked],
  );
  // A tab the writer hid can't stay selected: the strip's first tab shows instead.
  const source = shown.includes(picked) ? picked : (shown[0] ?? "manuscript");

  const catalogs = useContextCatalogViews(projectId, EDITOR_CONTEXT_SCHEMES, {
    workId: editorWorkId,
    enabled: contextLive,
  });
  const scratch = useChatScratch(projectId, chatThreadId);
  const areas = useMemo<MoveArea[]>(
    () => [
      ...EDITOR_CONTEXT_SCHEMES.flatMap((scheme) => {
        const catalog = catalogs[scheme].catalog;
        return catalog ? [{ scheme, owner: { workId: editorWorkId }, catalog, accepts: true }] : [];
      }),
      ...scratch.areas,
    ],
    [catalogs, editorWorkId, scratch.areas],
  );
  const list = useEntryList({ projectId, areas });
  const dropImport = useOptionalImports()?.drop;
  const files = useMemo<FilesRoute>(
    () => ({
      verdict: (target) => {
        const destination = destinationOf(target.scheme, target.folder);
        return destination ? { kind: "accept", label: t`Import into ${destination.name}` } : null;
      },
      drop: (target, items) => {
        const destination = destinationOf(target.scheme, target.folder);
        if (destination) dropImport?.(destination, items);
      },
    }),
    [dropImport],
  );
  const value = useMemo<WriteSources>(
    () => ({
      projectId,
      editorWorkId,
      activeScheme,
      activePath,
      onSelectFile,
      onPicked,
      catalogs,
      scratch,
      changes,
    }),
    [
      projectId,
      editorWorkId,
      activeScheme,
      activePath,
      onSelectFile,
      onPicked,
      catalogs,
      scratch,
      changes,
    ],
  );

  return (
    <WriteSourcesContext.Provider value={value}>
      <EntryList list={list} files={files}>
        <div className="flex min-h-0 flex-1 flex-col">
          <SourceTabs shown={shown} source={source} onSelect={setPicked} />
          <SourceView key={source} source={source} />
        </div>
      </EntryList>
    </WriteSourcesContext.Provider>
  );
}

/** The shown source's pane; keyed by source, so each source's drop hook keeps its own place. */
function SourceView({ source }: { source: SourceKey }) {
  const { useDrop, Body } = SOURCES[source];
  const drop = useDrop();
  return <Body drop={drop} />;
}

function SourceTabs({
  shown,
  source,
  onSelect,
}: {
  shown: readonly SourceKey[];
  source: SourceKey;
  onSelect: (key: SourceKey) => void;
}) {
  const toggle = useSidebarTabs((state) => state.toggle);
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 py-1">
      <div
        role="tablist"
        aria-label={t`Sources`}
        className="-m-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {shown.map((key) => (
          <SourceTab
            key={key}
            source={key}
            active={key === source}
            onSelect={() => onSelect(key)}
          />
        ))}
      </div>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger
              aria-label={t`Choose tabs`}
              className={cn(
                TAB_BUTTON,
                role.secondary,
                role.hover,
                role.open,
                "hover:text-foreground",
              )}
            >
              <Plus className={sidebarIcon.tab} aria-hidden />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t`Choose tabs`}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>{t`Tabs`}</DropdownMenuLabel>
          {ALL_SOURCES.map((key) => {
            const on = shown.includes(key);
            const Icon = SOURCES[key].icon;
            return (
              <DropdownMenuCheckboxItem
                key={key}
                checked={on}
                // The last tab stays: the sidebar always shows a list.
                disabled={on && shown.length === 1}
                onSelect={(event) => {
                  event.preventDefault();
                  toggle(key);
                }}
              >
                <Icon className={sidebarIcon.tab} aria-hidden />
                {SOURCES[key].label()}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * A tab and the strip's + button: 28px, 36px where the pointer is a finger.
 * The default six tabs and + still fit a default-width sidebar without scrolling the strip.
 */
const TAB_BUTTON =
  "focus-ring grid size-7 shrink-0 place-items-center rounded-md transition-colors [@media(hover:none)]:size-9 coarse:size-9";

/** A source's tab: a drop on it lands at the source's root, and a drag that rests opens it. */
function SourceTab({
  source,
  active,
  onSelect,
}: {
  source: SourceKey;
  active: boolean;
  onSelect: () => void;
}) {
  const { label, title, badge, icon: Icon, useDrop } = SOURCES[source];
  const sources = useWriteSources();
  const name = title?.(sources) ?? label();
  const count = badge?.(sources) ?? 0;
  const drop = useDrop(onSelect);
  const self = useRef<HTMLButtonElement>(null);
  // The strip scrolls when its tabs outgrow the sidebar: keep the selected one in view.
  useEffect(() => {
    if (active) self.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={self}
          type="button"
          role="tab"
          aria-selected={active}
          aria-label={count > 0 ? t`${name}, ${count} to review` : name}
          onClick={onSelect}
          {...drop.dropProps}
          className={cn(
            TAB_BUTTON,
            "relative",
            drop.dropState === "over"
              ? role.dropTarget
              : active
                ? role.selected
                : cn(role.secondary, role.hover, "hover:text-foreground"),
          )}
        >
          <Icon className={sidebarIcon.tab} aria-hidden />
          {count > 0 ? (
            <Chip
              kind="count"
              tone="jade"
              aria-hidden
              className="-top-1 -right-1 absolute h-4 min-w-4 px-1"
            >
              {count}
            </Chip>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{name}</TooltipContent>
    </Tooltip>
  );
}
