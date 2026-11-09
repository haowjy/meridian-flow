import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label={t`Sources`}
        className="flex shrink-0 items-center gap-0.5 px-2 py-1"
      >
        {TAB_SOURCES.map((key) => (
          <SourceTab
            key={key}
            source={key}
            active={key === source}
            onSelect={() => setSource(key)}
            onDropTrash={
              key === "trash"
                ? () => {
                    deletion.deleteEntries(draggedEntries());
                  }
                : undefined
            }
          />
        ))}
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
              <DropdownMenuItem key={key} onSelect={() => setSource(key)}>
                <SourceIcon source={key} />
                {sourceLabel(key)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div ref={paneRef} className="flex min-h-0 flex-1 flex-col">
        {source === "trash" ? (
          <TrashSource projectId={projectId} />
        ) : source === "scratch" ? (
          <ScratchSource
            projectId={projectId}
            threadId={chatThreadId}
            editorWorkId={editorWorkId}
          />
        ) : contextLive ? (
          <ContextTreePanel
            projectId={projectId}
            editorWorkId={editorWorkId}
            activeScheme={activeScheme}
            activePath={activePath}
            onSelectFile={onSelectFile}
            only={source}
          />
        ) : null}
      </div>
    </div>
  );
}

/** How long a drag rests on a tab before the tab opens, as on a closed folder. */
const SPRING_OPEN_MS = 600;

function SourceTab({
  source,
  active,
  onSelect,
  onDropTrash,
}: {
  source: SourceKey;
  active: boolean;
  onSelect: () => void;
  onDropTrash?: () => void;
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
          onDragOver={(event) => {
            if (!activeDragSession()) return;
            if (onDropTrash) acceptEntryDrag(event);
            if (spring.current || active) return;
            setOver(true);
            spring.current = setTimeout(() => {
              spring.current = null;
              onSelect();
            }, SPRING_OPEN_MS);
          }}
          onDragLeave={cancelSpring}
          onDrop={(event) => {
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
            over && "bg-sidebar-accent ring-1 ring-border-focus ring-inset",
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
