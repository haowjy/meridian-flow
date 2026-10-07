/**
 * DraftSwitcher — the review header's document name with its menu: the Work's
 * drafts to move between (one per document, with its change count), the way
 * back to live, and the Work-wide Apply all and Discard all.
 *
 * On a phone (`touch`) the header has no room for Apply draft, Discard draft or
 * the Show changes switch, so the menu carries them: pass `draftCommands` and
 * `marks` and they appear. Both are the same commands the desktop header runs.
 *
 * Presentational: it is handed the rows and the commands. The Work is the
 * current one only; a draft in another Work is not in this list.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";
import type { DraftCommandFailureCode } from "@/client/query/draft-command-record";
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
import { ReviewMessageText } from "@/features/chat/ReviewMessageText";
import { cn } from "@/lib/utils";

export type DraftSwitcherProps = {
  rows: readonly DockRow[];
  /** The document under review. */
  currentDocumentId: string;
  /** The current document's name when it is no longer among `rows` (its draft was handled to the end). */
  currentName?: string | null;
  /** Changes per document; absent while the count is still being read. */
  counts: ReadonlyMap<string, number>;
  /** What a refused or unanswered command left on a document's draft, so the row says so wherever the review is. */
  failures?: ReadonlyMap<string, DraftCommandFailureCode>;
  /** The menu is open or about to be: counts are read only then. */
  onOpenChange: (open: boolean) => void;
  /** A draft-only document has no live version: its exit closes the tab. */
  draftOnly: boolean;
  disabled: boolean;
  onOpenDraft: (row: DockRow) => void;
  onShowLive: () => void;
  onApplyAll: () => void;
  onDiscardAll: () => void;
  /** A phone's header: the trigger is a 44px target and its name may be wider. */
  touch?: boolean;
  /** Whole-draft commands for this document, offered in the menu (phone). Absent once nothing is left to publish. */
  draftCommands?: {
    canApply: boolean;
    applying: boolean;
    onApply: () => void;
    onDiscard: () => void;
  };
  /** The marks switch, offered in the menu (phone). */
  marks?: { visible: boolean; onChange: (visible: boolean) => void };
};

export function DraftSwitcher({
  rows,
  currentDocumentId,
  currentName = null,
  counts,
  failures,
  onOpenChange,
  draftOnly,
  disabled,
  onOpenDraft,
  onShowLive,
  onApplyAll,
  onDiscardAll,
  touch = false,
  draftCommands,
  marks,
}: DraftSwitcherProps) {
  const [open, setOpen] = useState(false);
  const current = rows.find((row) => row.documentId === currentDocumentId) ?? null;
  const untitled = t`Untitled document`;
  const name = current ? dockRowName(current, untitled) : (currentName ?? untitled);
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
          "focus-ring inline-flex min-w-0 items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-caption font-semibold transition-colors",
          "hover:border-border hover:bg-sidebar-accent data-[state=open]:border-border data-[state=open]:bg-sidebar-accent",
          touch ? "min-h-11 max-w-full text-sm" : "max-w-64",
        )}
      >
        <span className="truncate">{name}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={touch ? "w-[min(20rem,calc(100vw-1rem))]" : "w-80"}
      >
        <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">
          <Trans>Drafts in this Work</Trans>
        </DropdownMenuLabel>
        {rows.map((row) => {
          const isCurrent = row.documentId === currentDocumentId;
          const count = counts.get(row.documentId);
          const failure = failures?.get(row.documentId);
          return (
            <DropdownMenuItem
              key={row.documentId}
              onSelect={() => {
                if (!isCurrent) onOpenDraft(row);
              }}
              className={cn(
                "grid grid-cols-[1rem_minmax(0,1fr)_auto] gap-x-2 gap-y-0.5",
                // A row that carries a message grows to hold it.
                failure &&
                  "h-auto min-h-8 py-1.5 [@media(pointer:coarse)]:h-auto [@media(pointer:coarse)]:min-h-11",
              )}
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
              {failure ? (
                <span className="col-start-2 col-span-2 text-caption text-destructive" role="alert">
                  <ReviewMessageText code={failure} />
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        {draftCommands ? (
          <>
            <DropdownMenuItem
              disabled={disabled || !draftCommands.canApply}
              onSelect={draftCommands.onApply}
              className="pl-7 font-medium"
            >
              {draftCommands.applying ? <Loader2 className="animate-spin" aria-hidden /> : null}
              <Trans>Apply draft</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={disabled}
              onSelect={draftCommands.onDiscard}
              className="pl-7"
            >
              <Trans>Discard draft</Trans>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={onShowLive} className="pl-7">
          {draftOnly ? <Trans>Close review</Trans> : <Trans>Show live version</Trans>}
        </DropdownMenuItem>
        {marks ? (
          <DropdownMenuItem onSelect={() => marks.onChange(!marks.visible)} className="pl-7">
            {marks.visible ? <Trans>Hide changes</Trans> : <Trans>Show changes</Trans>}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
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
