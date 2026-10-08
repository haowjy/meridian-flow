/**
 * DrillInSheet — the phone's `DrillInMenu`: a bottom sheet that browses the
 * same tree source in place. A folder replaces the list, with a "‹ folder" row
 * under the heading to step back out. There is no actions area: a phone picks a
 * note and the caller opens it full screen.
 *
 * It takes the menu's tree and node types so one source serves both
 * presentations. It owns only the drill state; picking belongs to the caller.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import type { DrillNode, DrillTree } from "./DrillInMenu";

export function DrillInSheet({
  open,
  onOpenChange,
  tree,
  currentId,
  openAt,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tree: DrillTree;
  /** The entry the writer is on; it is highlighted wherever it appears. */
  currentId: string | null;
  /** The folders, outermost first, the sheet opens inside. */
  openAt: readonly DrillNode[];
  onPick: (node: DrillNode) => void;
}) {
  const [trail, setTrail] = useState<readonly DrillNode[]>(openAt);
  const folder = trail.at(-1) ?? null;
  const entries = tree.children(folder?.id ?? null);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) setTrail(openAt);
        onOpenChange(next);
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="max-h-[80dvh] gap-0 rounded-t-xl p-0 pb-[env(safe-area-inset-bottom)]"
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />
        <SheetTitle className="truncate px-4 pt-3 pb-1 text-sm">{tree.heading}</SheetTitle>
        <SheetDescription className="sr-only">
          <Trans>Choose a note to open.</Trans>
        </SheetDescription>
        {folder ? (
          <button
            type="button"
            className="focus-ring flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm font-medium active:bg-sidebar-accent"
            aria-label={t`Back from ${folder.name}`}
            onClick={() => setTrail(trail.slice(0, -1))}
          >
            <ChevronLeft aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          </button>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {entries.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              <Trans>Nothing here yet.</Trans>
            </p>
          ) : (
            <ul>
              {entries.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    aria-current={node.id === currentId ? "true" : undefined}
                    className={cn(
                      "focus-ring flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm active:bg-sidebar-accent",
                      node.id === currentId && "bg-dropdown-selected font-medium",
                    )}
                    onClick={() => {
                      if (node.folder) setTrail([...trail, node]);
                      else onPick(node);
                    }}
                  >
                    <node.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    {node.folder ? (
                      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
