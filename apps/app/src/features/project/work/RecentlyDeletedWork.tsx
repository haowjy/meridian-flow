/**
 * Recently deleted Work: soft-deleted Works stay restorable, with everything
 * that went with them, until their purge date. A collapsed disclosure under
 * Archived; each row restores in place.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { WORK_DELETE_RETENTION_DAYS, type Work, workPurgeAt } from "@meridian/contracts/works";
import { ChevronRight } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { HttpResponseError } from "@/client/api/http-client";
import { useWorkMutations } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

export type WorkRestore = ReturnType<typeof useWorkRestore>;

/** Optimistic restore: the Work returns to Active at once; a failure lands on its deleted row. */
export function useWorkRestore(projectId: string) {
  const mutations = useWorkMutations(projectId);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; error: Error } | null>(null);
  const restore = useCallback(
    (work: Work) => {
      setFailure(null);
      setRestoringId(work.id);
      mutations.restore.mutate(work.id, {
        onSuccess: () => setRestoringId(null),
        onError: (error) => {
          setRestoringId(null);
          setFailure({ id: work.id, error });
        },
      });
    },
    [mutations.restore],
  );
  return { restoringId, failure, restore };
}

/** Deleted Works still inside their retention window, minus one already offered for Undo. */
export function restorableWorks(deleted: readonly Work[], now: number, exceptId?: string) {
  return deleted.filter(
    (work) =>
      work.deletedAt !== null &&
      work.id !== exceptId &&
      workPurgeAt(work.deletedAt).getTime() > now,
  );
}

export function RecentlyDeletedWork({
  works,
  now,
  restore,
  open,
  onOpenChange,
}: {
  works: readonly Work[];
  now: number;
  restore: WorkRestore;
  /** Owned by the collection so it survives the section emptying during a restore. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const listId = useId();
  const shown = works.filter((work) => work.id !== restore.restoringId);
  if (!shown.length) return null;
  return (
    <section
      data-disclosure
      className="pt-7 [[data-disclosure]+&]:pt-1"
      aria-label={t`Recently deleted Work`}
    >
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => onOpenChange(!open)}
          className="focus-ring flex min-h-8 items-center gap-1.5 rounded-sm px-2 [@media(pointer:coarse)]:min-h-11"
        >
          <SectionLabel variant="group">
            <Trans>Recently deleted</Trans>
          </SectionLabel>
          <span className="text-meta tabular-nums text-ink-subtle">{shown.length}</span>
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 text-ink-subtle transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </button>
      </h2>
      {open ? (
        <>
          <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
            <Trans>
              Restoring brings back the Work with its chats, drafts, Scratch and Uploads.
            </Trans>
          </p>
          <ul id={listId} className="min-w-0">
            {shown.map((work, index) => (
              <li key={work.id} className={cn("relative", index < shown.length - 1 && "row-rule")}>
                <DeletedRow work={work} now={now} onRestore={() => restore.restore(work)} />
                {restore.failure?.id === work.id ? (
                  <div className="px-2">
                    <RestoreFailure
                      error={restore.failure.error}
                      onRetry={() => restore.restore(work)}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function DeletedRow({ work, now, onRestore }: { work: Work; now: number; onRestore: () => void }) {
  const days = Math.max(
    0,
    Math.ceil((workPurgeAt(work.deletedAt ?? new Date(now)).getTime() - now) / DAY_MS),
  );
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-3 px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-muted-foreground">
          {work.name}
        </span>
        <span className="block truncate text-xs text-ink-subtle">
          {days <= 1
            ? t`Deletes for good within a day`
            : plural(days, {
                one: "Deletes for good in # day",
                other: "Deletes for good in # days",
              })}
        </span>
      </div>
      <button
        type="button"
        onClick={onRestore}
        aria-label={t`Restore ${work.name}`}
        className="text-button shrink-0 text-sm [@media(pointer:coarse)]:min-h-11"
      >
        <Trans>Restore</Trans>
      </button>
    </div>
  );
}

function RestoreFailure({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const status = error instanceof HttpResponseError ? error.status : null;
  if (status === 409)
    return (
      <p role="alert" className="pb-2 text-sm text-destructive">
        <Trans>Another Work now has this name. Rename that Work, then restore this one.</Trans>
      </p>
    );
  if (status === 410)
    return (
      <p role="alert" className="pb-2 text-sm text-destructive">
        <Trans>
          This Work was deleted more than {WORK_DELETE_RETENTION_DAYS} days ago and can’t be
          restored.
        </Trans>
      </p>
    );
  return <InlineErrorRow message={t`Couldn’t restore this Work`} onRetry={onRetry} />;
}
