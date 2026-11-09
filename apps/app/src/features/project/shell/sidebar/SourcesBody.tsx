import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { type HTMLAttributes, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { TrashSource } from "./TrashSource";
import { acceptEntryDrag, draggedEntries } from "./trash-drop";

type SourceKey = "manuscript" | "kb" | "scratch" | "user" | "trash" | "unfiled";

/** Fixed slots, then the "…" slot. A source picked from "…" shows in that slot, so no tab moves. */
const TAB_SOURCES: readonly SourceKey[] = ["manuscript", "kb", "scratch", "user", "trash"];
const OVERFLOW_SOURCES: readonly SourceKey[] = ["unfiled"];

/**
 * Write mode's sidebar: one source at a time behind icon tabs, so the
 * manuscript gets the full height. The open document's source becomes the
 * shown one when it changes.
 */
export function SourcesBody({
  projectId,
  editorWorkId,
  chatThreadId,
  contextLive,
  activeScheme,
  activePath,
  onSelectFile,
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
  paneRef?: RefObject<HTMLDivElement | null>;
}) {
  const [source, setSource] = useState<SourceKey>("manuscript");
  useEffect(() => {
    if (activeScheme && isSourceKey(activeScheme)) setSource(activeScheme);
  }, [activeScheme]);
  const overflowShown = OVERFLOW_SOURCES.includes(source);
  const deletion = useDeleteContextEntry(projectId);

  const selectFrom = (key: SourceKey) => () => setSource(key);
  const tabs = (rootIdOf?: (scheme: ProjectContextTreeScheme) => string | null) => (
    <div
      role="tablist"
      aria-label={t`Sources`}
      className="flex shrink-0 items-center gap-0.5 px-2 py-1"
    >
      {TAB_SOURCES.map((key) => {
        const rootId = key !== "trash" && key !== "scratch" ? (rootIdOf?.(key) ?? null) : null;
        return rootId && key !== "trash" && key !== "scratch" ? (
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
      <span className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            role="tab"
            aria-selected={overflowShown}
            aria-label={t`More sources`}
            className={cn(
              "focus-ring flex h-7 items-center gap-1 rounded-md px-1.5 text-ink-muted hover:bg-sidebar-accent/50 hover:text-foreground",
              overflowShown && "bg-sidebar-accent text-foreground",
            )}
          >
            {overflowShown ? <SourceIcon source={source} /> : null}
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {OVERFLOW_SOURCES.map((key) => (
            <DropdownMenuItem key={key} onSelect={selectFrom(key)}>
              <SourceIcon source={key} />
              {sourceLabel(key)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  const other =
    source === "trash" ? (
      <TrashSource projectId={projectId} />
    ) : source === "scratch" ? (
      <ScratchSource projectId={projectId} threadId={chatThreadId} editorWorkId={editorWorkId} />
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
          only={source === "trash" || source === "scratch" ? undefined : source}
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
  source: Exclude<SourceKey, "trash" | "scratch">;
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
            "focus-ring grid h-7 w-8 place-items-center rounded-md transition-colors",
            active
              ? "bg-sidebar-accent text-foreground"
              : "text-ink-muted hover:bg-sidebar-accent/50 hover:text-foreground",
            (over || lit) && "bg-sidebar-accent ring-1 ring-border-focus ring-inset",
          )}
        >
          <SourceIcon source={source} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{sourceLabel(source)}</TooltipContent>
    </Tooltip>
  );
}

function SourceIcon({ source }: { source: SourceKey }) {
  const Icon = source === "trash" ? Trash2 : schemeIcon(source);
  return <Icon className="size-4" aria-hidden />;
}

function sourceLabel(source: SourceKey): string {
  return source === "trash" ? t`Trash` : schemeLabel(source);
}

function isSourceKey(scheme: ProjectContextTreeScheme): scheme is Exclude<SourceKey, "trash"> {
  return (
    scheme === "manuscript" ||
    scheme === "kb" ||
    scheme === "scratch" ||
    scheme === "user" ||
    scheme === "unfiled"
  );
}
