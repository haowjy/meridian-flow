/**
 * DraftSwitcher — the review header's document name with its menu: the Work's
 * drafts to move between (one per document, with its change count), the way
 * back to live, and the Work-wide Apply all and Discard all.
 *
 * Presentational: it is handed the rows and the commands. The Work is the
 * current one only; a draft in another Work is not in this list.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type DockRow, dockRowName } from "@/features/chat/docked-drafts";
import { cn } from "@/lib/utils";

export type DraftSwitcherProps = {
  rows: readonly DockRow[];
  /** The document under review. */
  currentDocumentId: string;
  /** Changes per document; absent while the count is still being read. */
  counts: ReadonlyMap<string, number>;
  /** The menu is open or about to be: counts are read only then. */
  onOpenChange: (open: boolean) => void;
  /** A draft-only document has no live version: its exit closes the tab. */
  draftOnly: boolean;
  disabled: boolean;
  onOpenDraft: (row: DockRow) => void;
  onShowLive: () => void;
  onApplyAll: () => void;
  onDiscardAll: () => void;
};

export function DraftSwitcher({
  rows,
  currentDocumentId,
  counts,
  onOpenChange,
  draftOnly,
  disabled,
  onOpenDraft,
  onShowLive,
  onApplyAll,
  onDiscardAll,
}: DraftSwitcherProps) {
  const [open, setOpen] = useState(false);
  const current = rows.find((row) => row.documentId === currentDocumentId) ?? null;
  const untitled = t`Untitled document`;
  const name = current ? dockRowName(current, untitled) : untitled;
  const total = rows.length;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange(next);
      }}
    >
      <DropdownMenuTrigger
        aria-label={t`Switch draft, now ${name}`}
        className={cn(
          "focus-ring inline-flex min-w-0 max-w-64 items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-caption font-semibold transition-colors",
          "hover:border-border hover:bg-sidebar-accent data-[state=open]:border-border data-[state=open]:bg-sidebar-accent",
        )}
      >
        <span className="truncate">{name}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">
          <Trans>Drafts in this Work</Trans>
        </DropdownMenuLabel>
        {rows.map((row) => {
          const isCurrent = row.documentId === currentDocumentId;
          const count = counts.get(row.documentId);
          return (
            <DropdownMenuItem
              key={row.documentId}
              onSelect={() => {
                if (!isCurrent) onOpenDraft(row);
              }}
              className="grid grid-cols-[1rem_minmax(0,1fr)_auto] gap-2"
            >
              <span className="text-primary">
                {isCurrent ? <Check aria-hidden className="size-3.5" /> : null}
              </span>
              <span className="truncate">{dockRowName(row, untitled)}</span>
              {row.isNewDocument ? (
                <Badge>
                  <Trans>New document</Trans>
                </Badge>
              ) : count === undefined ? null : (
                <span className="text-caption text-muted-foreground tabular-nums">
                  {count === 1 ? t`1 change` : t`${count} changes`}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onShowLive} className="pl-7">
          {draftOnly ? <Trans>Close review</Trans> : <Trans>Show live version</Trans>}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled || total === 0} onSelect={onApplyAll} className="pl-7">
          {total === 1 ? <Trans>Apply all 1 draft</Trans> : <Trans>Apply all {total} drafts</Trans>}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={disabled || total === 0}
          onSelect={onDiscardAll}
          className="pl-7"
        >
          {total === 1 ? (
            <Trans>Discard all 1 draft</Trans>
          ) : (
            <Trans>Discard all {total} drafts</Trans>
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
