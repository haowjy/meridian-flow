import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Check, MessageSquare, Plus, Trash2 } from "lucide-react";
import {
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ScratchSource } from "../../chat/ChatScratch";
import { ContextTreePanel } from "../../context/ContextTreePanel";
import { schemeIcon, schemeLabel } from "../../context/context-schemes";
import { activeDragSession } from "../../context/entry-drag/drag-session";
import { type TreeDropTarget, useTreeDropTarget } from "../../context/tree-drop/tree-drop";
import { useDeleteContextEntry } from "../../context/use-delete-context-entry";
import { ALL_SOURCES, type SourceKey, useSidebarTabs } from "./sidebar-tabs-store";
import { TrashSource } from "./TrashSource";
import { acceptEntryDrag, draggedEntries } from "./trash-drop";

type TreeSource = Exclude<SourceKey, "trash" | "scratch" | "chats">;

function isTreeSource(key: SourceKey): key is TreeSource {
  return key !== "trash" && key !== "scratch" && key !== "chats";
}

/**
 * The sidebar: one source at a time behind a strip of tabs, so each list gets
 * the full height. The selected tab shows its name; + picks which tabs the
 * strip shows. Which list shows is independent of the mode. The open
 * document's source becomes the shown one when it changes.
 */
export function SourcesBody({
  projectId,
  editorWorkId,
  chatThreadId,
  contextLive,
  activeScheme,
  activePath,
  onSelectFile,
  chats,
  paneRef,
}: {
  projectId: string;
  editorWorkId: string | null;
  chatThreadId: string | null;
  contextLive: boolean;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  onSelectFile: (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => void;
  /** The Chats tab's list. */
  chats: ReactNode;
  paneRef?: RefObject<HTMLDivElement | null>;
}) {
  const shown = useSidebarTabs((state) => state.shown);
  const toggle = useSidebarTabs((state) => state.toggle);
  useEffect(() => {
    void useSidebarTabs.persist.rehydrate();
  }, []);
  const [picked, setPicked] = useState<SourceKey>("manuscript");
  useEffect(() => {
    if (activeScheme && isSourceKey(activeScheme)) setPicked(activeScheme);
  }, [activeScheme]);
  // A tab the writer hid can't stay selected: the strip's first tab shows instead.
  const source = shown.includes(picked) ? picked : (shown[0] ?? "manuscript");
  const deletion = useDeleteContextEntry(projectId);

  const selectFrom = (key: SourceKey) => () => setPicked(key);
  const tabs = (rootIdOf?: (scheme: ProjectContextTreeScheme) => string | null) => (
    <div className="flex shrink-0 items-center gap-1 px-2 py-1">
      <div
        role="tablist"
        aria-label={t`Sources`}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {shown.map((key) => {
          const rootId = isTreeSource(key) ? (rootIdOf?.(key) ?? null) : null;
          return rootId && isTreeSource(key) ? (
            <TreeSourceTab
              key={key}
              source={key}
              rootId={rootId}
              active={key === source}
              onSelect={selectFrom(key)}
            />
          ) : (
            <SourceTab
              key={key}
              source={key}
              active={key === source}
              onSelect={selectFrom(key)}
              onDropTrash={
                key === "trash" ? () => deletion.deleteEntries(draggedEntries()) : undefined
              }
            />
          );
        })}
      </div>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger
              aria-label={t`Choose tabs`}
              className="focus-ring grid size-7 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-sidebar-accent/50 hover:text-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
            >
              <Plus className="size-4" aria-hidden />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t`Choose tabs`}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>{t`Tabs`}</DropdownMenuLabel>
          {ALL_SOURCES.map((key) => {
            const on = shown.includes(key);
            return (
              <DropdownMenuItem
                key={key}
                role="menuitemcheckbox"
                aria-checked={on}
                // The last tab stays: the sidebar always shows a list.
                disabled={on && shown.length === 1}
                onSelect={(event) => {
                  event.preventDefault();
                  toggle(key);
                }}
              >
                <SourceIcon source={key} />
                <span className="flex-1">{sourceLabel(key)}</span>
                <Check className={cn("size-3.5", on ? "opacity-100" : "opacity-0")} aria-hidden />
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  const other =
    source === "trash" ? (
      <TrashSource projectId={projectId} />
    ) : source === "scratch" ? (
      <ScratchSource projectId={projectId} threadId={chatThreadId} editorWorkId={editorWorkId} />
    ) : source === "chats" ? (
      chats
    ) : undefined;

  return (
    <div ref={paneRef} className="flex min-h-0 flex-1 flex-col">
      {contextLive ? (
        <ContextTreePanel
          projectId={projectId}
          editorWorkId={editorWorkId}
          activeScheme={activeScheme}
          activePath={activePath}
          onSelectFile={onSelectFile}
          only={isTreeSource(source) ? source : undefined}
          tabs={tabs}
          body={other}
        />
      ) : (
        <>
          {tabs()}
          {other}
        </>
      )}
    </div>
  );
}

/** A tree source's tab: a drop lands at the source's root, and a drag that rests opens it. */
function TreeSourceTab({
  source,
  rootId,
  active,
  onSelect,
}: {
  source: TreeSource;
  rootId: string;
  active: boolean;
  onSelect: () => void;
}) {
  const target = useMemo<TreeDropTarget>(
    () => ({ scheme: source, catalogRootId: rootId, folder: null }),
    [source, rootId],
  );
  const drop = useTreeDropTarget(target, { reveal: onSelect });
  return (
    <SourceTab
      source={source}
      active={active}
      onSelect={onSelect}
      dropProps={drop.dropProps}
      lit={drop.dropState === "over"}
    />
  );
}

/** How long a drag rests on a tab before the tab opens, as on a closed folder. */
const SPRING_OPEN_MS = 600;

function SourceTab({
  source,
  active,
  onSelect,
  onDropTrash,
  dropProps,
  lit = false,
}: {
  source: SourceKey;
  active: boolean;
  onSelect: () => void;
  onDropTrash?: () => void;
  /** The tree's drop handlers, for a tab that drops at its source's root. */
  dropProps?: HTMLAttributes<HTMLElement>;
  lit?: boolean;
}) {
  const spring = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [over, setOver] = useState(false);
  const self = useRef<HTMLButtonElement>(null);
  // The strip scrolls when its tabs outgrow the sidebar: keep the selected one in view.
  useEffect(() => {
    if (active) self.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const cancelSpring = () => {
    if (spring.current) clearTimeout(spring.current);
    spring.current = null;
    setOver(false);
  };
  useEffect(() => cancelSpring, []);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={self}
          type="button"
          role="tab"
          aria-selected={active}
          aria-label={sourceLabel(source)}
          onClick={onSelect}
          {...dropProps}
          onDragOver={(event) => {
            if (dropProps) return dropProps.onDragOver?.(event);
            if (!activeDragSession()) return;
            if (onDropTrash) acceptEntryDrag(event);
            if (spring.current || active) return;
            setOver(true);
            spring.current = setTimeout(() => {
              spring.current = null;
              onSelect();
            }, SPRING_OPEN_MS);
          }}
          onDragLeave={dropProps?.onDragLeave ?? cancelSpring}
          onDrop={(event) => {
            if (dropProps) return dropProps.onDrop?.(event);
            cancelSpring();
            if (!onDropTrash) return;
            event.preventDefault();
            onDropTrash();
          }}
          className={cn(
            "focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md text-[13px] transition-colors",
            active
              ? "bg-sidebar-accent px-2 font-medium text-foreground"
              : "w-7 justify-center text-ink-muted hover:bg-sidebar-accent/50 hover:text-foreground",
            (over || lit) && "bg-sidebar-accent ring-1 ring-border-focus ring-inset",
          )}
        >
          <SourceIcon source={source} />
          {/* The selected tab names itself; the others name themselves on hover. */}
          {active ? <span className="whitespace-nowrap">{sourceLabel(source)}</span> : null}
        </button>
      </TooltipTrigger>
      {active ? null : <TooltipContent side="bottom">{sourceLabel(source)}</TooltipContent>}
    </Tooltip>
  );
}

function SourceIcon({ source }: { source: SourceKey }) {
  const Icon =
    source === "trash" ? Trash2 : source === "chats" ? MessageSquare : schemeIcon(source);
  return <Icon className="size-4" aria-hidden />;
}

function sourceLabel(source: SourceKey): string {
  return source === "trash" ? t`Trash` : source === "chats" ? t`Chats` : schemeLabel(source);
}

function isSourceKey(
  scheme: ProjectContextTreeScheme,
): scheme is Exclude<SourceKey, "trash" | "chats"> {
  return (
    scheme === "manuscript" ||
    scheme === "kb" ||
    scheme === "scratch" ||
    scheme === "user" ||
    scheme === "unfiled"
  );
}
