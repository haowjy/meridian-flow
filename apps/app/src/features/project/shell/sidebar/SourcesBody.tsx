import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { MoreHorizontal } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
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

type SourceKey = "manuscript" | "kb" | "scratch" | "unfiled";

/** Fixed slots, then the "…" slot. A source picked from "…" shows in that slot, so no tab moves. */
const TAB_SOURCES: readonly SourceKey[] = ["manuscript", "kb", "scratch"];
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
                {schemeLabel(key)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div ref={paneRef} className="flex min-h-0 flex-1 flex-col">
        {source === "scratch" ? (
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

function SourceTab({
  source,
  active,
  onSelect,
}: {
  source: SourceKey;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="tab"
          aria-selected={active}
          aria-label={schemeLabel(source)}
          onClick={onSelect}
          className={cn(
            "focus-ring grid h-7 w-8 place-items-center rounded-md transition-colors",
            active
              ? "bg-sidebar-accent text-foreground"
              : "text-ink-muted hover:bg-sidebar-accent/50 hover:text-foreground",
          )}
        >
          <SourceIcon source={source} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{schemeLabel(source)}</TooltipContent>
    </Tooltip>
  );
}

function SourceIcon({ source }: { source: SourceKey }) {
  const Icon = schemeIcon(source);
  return <Icon className="size-4" aria-hidden />;
}

function isSourceKey(scheme: ProjectContextTreeScheme): scheme is SourceKey {
  return scheme === "manuscript" || scheme === "kb" || scheme === "scratch" || scheme === "unfiled";
}
