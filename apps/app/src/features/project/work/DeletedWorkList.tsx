/**
 * The Work list's Deleted tab: soft-deleted Works stay restorable, with
 * everything that went with them, until their purge date. Each row restores
 * in place.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  DAY_MS,
  WORK_DELETE_RETENTION_DAYS,
  type Work,
  workPurgeAt,
} from "@meridian/contracts/works";
import { cn } from "@/lib/utils";
import { WorkCommandFailureRow } from "./WorkCommandFailureRow";
import type { WorkListEntry } from "./work-list-model";

export function DeletedWorkList({
  entries,
  now,
  onRestore,
}: {
  entries: readonly WorkListEntry[];
  now: number;
  onRestore: (work: Work) => void;
}) {
  if (!entries.length)
    return (
      <p className="px-2 py-2 text-sm text-muted-foreground">
        <Trans>
          Deleted Work stays here for {WORK_DELETE_RETENTION_DAYS} days, then it’s gone for good.
        </Trans>
      </p>
    );
  return (
    <>
      <p className="px-2 pb-2 text-xs text-muted-foreground">
        <Trans>Restoring brings back a Work with its chats, drafts, Scratch and Uploads.</Trans>
      </p>
      <ul className="min-w-0">
        {entries.map(({ key, work, failure }, index) => (
          <li key={key} className={cn("relative", index < entries.length - 1 && "row-rule")}>
            <DeletedRow work={work} now={now} onRestore={() => onRestore(work)} />
            {failure ? (
              <div className="px-2">
                <WorkCommandFailureRow failure={failure} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </>
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
