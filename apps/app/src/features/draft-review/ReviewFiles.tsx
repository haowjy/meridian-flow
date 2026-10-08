/**
 * ReviewFiles — the Work's draft files as one list, in one stable order, with
 * the file under review expanded in place showing its changes. Moving to another
 * file never reorders the list or lifts the open file to the top; the open
 * file's changes are in document order (`reviewChanges`).
 *
 * It is the dock's Changes tab and the phone's changes sheet. Moving between
 * files belongs here (the Draft chip's menu is versions of one document), and so
 * do the Work-wide Apply all and Discard all, in the `batch` menu at the top.
 *
 * Presentational: the caller builds the files (name, order, errors, what a tap
 * does) and hands the open file's body as children. `touch` raises targets to 44px.
 *
 * One list is one Work: the menu and the count in front of it are of the files'
 * drafts that Apply all and Discard all act on (`batch.count`), which leaves out
 * a finished review still shown (`held`). A second Work's drafts are a second
 * list with its own `title`.
 *
 * A file row is memoized on its file object, which the caller keeps when
 * nothing about that file changed, so moving focus among the open file's
 * changes renders none of the closed rows.
 */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { MoreHorizontal } from "lucide-react";
import { memo, type ReactNode } from "react";
import type { DraftCommandFailure } from "@/client/query/draft-command-record";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { NewBadge } from "@/components/app/NewBadge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type DraftStats, DraftStatsLabel } from "@/features/chat/draft-stats";
import { ReviewMessageText } from "@/features/chat/ReviewMessageText";
import { cn } from "@/lib/utils";

export type ReviewFile = {
  key: string;
  /** Null when the draft has no name to show; the words for that are chosen when shown. */
  name: string | null;
  /** The review's draft has left the list (finished): shown by name, not a draft to review. */
  held: boolean;
  /** The file under review: expanded in place, never a row to open again. */
  open: boolean;
  isNewDocument: boolean;
  /** The open file's number of changes, once known; right of its name. */
  changeCount: number | null;
  /** Word stats of a closed file's draft, right of its name. */
  stats: DraftStats;
  /** A held failure on this file's draft, such as a Review that could not open. */
  error: DraftCommandFailure | null;
  onOpen: () => void;
  onDismissError: () => void;
};

export type ReviewFilesBatch = {
  /** How many drafts Apply all and Discard all act on; the caption in front of the menu counts the same. */
  count: number;
  disabled: boolean;
  onApplyAll: () => void;
  onDiscardAll: () => void;
};

export function ReviewFiles({
  files,
  batch,
  title,
  touch = false,
  children,
}: {
  /** Every draft file once, in `sortDraftFiles` order. */
  files: readonly ReviewFile[];
  batch?: ReviewFilesBatch;
  /** The Work's name, when more than one Work's drafts are listed. */
  title?: string;
  touch?: boolean;
  /** The open file's body: its changes, or the state that stands in for them. */
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1" data-review-files aria-label={title}>
      {title ? <p className="px-2 pt-1 text-caption font-medium text-foreground">{title}</p> : null}
      {batch && batch.count > 0 ? <BatchMenu batch={batch} title={title} touch={touch} /> : null}
      {files.map((file) =>
        file.open ? (
          <section
            key={file.key}
            aria-label={t`Changes in ${fileName(file)}`}
            className="flex flex-col gap-1"
            data-review-file-open
          >
            <h3 className="flex items-baseline gap-2 px-2 pt-1 text-caption font-medium text-foreground">
              <span className="min-w-0 flex-1 truncate">{fileName(file)}</span>
              {file.changeCount !== null ? (
                <span className="shrink-0 text-meta font-normal text-muted-foreground tabular-nums">
                  <Plural value={file.changeCount} one="# change" other="# changes" />
                </span>
              ) : null}
            </h3>
            {children}
          </section>
        ) : (
          <FileRow key={file.key} file={file} touch={touch} />
        ),
      )}
    </section>
  );
}

/** What a file is called as a string: its name, else a word for a draft that has none. */
function fileName(file: ReviewFile): string {
  return file.name ?? (file.held ? t`This draft` : t`Untitled document`);
}

function BatchMenu({
  batch,
  title,
  touch,
}: {
  batch: ReviewFilesBatch;
  title: string | undefined;
  touch: boolean;
}) {
  const total = batch.count;
  return (
    <div className="flex items-center gap-2 px-2 text-caption text-muted-foreground">
      <p className="min-w-0 flex-1 truncate">
        <Plural value={total} one="# draft to review" other="# drafts to review" />
      </p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="quiet"
            size={touch ? "default" : "xs"}
            className={touch ? "size-11 p-0" : "size-6 p-0"}
            aria-label={title ? t`All drafts in ${title}` : t`All drafts`}
          >
            <MoreHorizontal aria-hidden className={touch ? "size-5" : "size-3.5"} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem disabled={batch.disabled} onSelect={batch.onApplyAll}>
            {total === 1 ? (
              <Trans>Apply all 1 draft</Trans>
            ) : (
              <Trans>Apply all {total} drafts</Trans>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={batch.disabled}
            onSelect={batch.onDiscardAll}
          >
            {total === 1 ? (
              <Trans>Discard all 1 draft</Trans>
            ) : (
              <Trans>Discard all {total} drafts</Trans>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const FileRow = memo(function FileRow({ file, touch }: { file: ReviewFile; touch: boolean }) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={file.onOpen}
        className={cn(
          "group focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/40",
          touch && "min-h-11",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {file.name ?? (file.held ? <Trans>This draft</Trans> : <Trans>Untitled document</Trans>)}
        </span>
        {/* The one signal that differentiates a new-document row from an edited
            one: a quiet neutral badge between the name and the stats. Its
            additions-only stats (`+N`, no `−0`) reinforce it (spec §5.5). */}
        {file.isNewDocument ? <NewBadge /> : null}
        {file.stats ? (
          <span className="shrink-0 text-caption">
            <DraftStatsLabel stats={file.stats} wordsSuffix={false} />
          </span>
        ) : null}
        <span
          className={cn(
            "shrink-0 text-caption font-medium text-primary transition-opacity",
            touch
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
        >
          <Trans>Review</Trans>
        </span>
      </button>
      {file.error ? (
        <InlineErrorRow
          message={<ReviewMessageText failure={file.error} />}
          onDismiss={file.onDismissError}
        />
      ) : null}
    </div>
  );
});
