/**
 * The Work list's Deleted tab: soft-deleted Works stay restorable, with
 * everything that went with them, until the server purges them. Each row
 * restores in place; a purged Work's Restore says it is gone.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { ListLine } from "@/components/ui/list-row";
import { RuledList } from "../RuledList";
import { WorkCommandFailureRow } from "./WorkCommandFailureRow";
import type { ListedWorkEntry } from "./work-list-model";

export function DeletedWorkList({
  entries,
  onRestore,
}: {
  entries: readonly ListedWorkEntry[];
  onRestore: (work: Work) => void;
}) {
  if (!entries.length)
    return (
      <div className="px-0.5">
        <ListLine>
          <Trans>Deleted Work can be restored.</Trans>
        </ListLine>
      </div>
    );
  return (
    <RuledList
      rows={entries.map(({ key, work, failure }) => ({
        key,
        node: (
          <>
            <DeletedRow work={work} onRestore={() => onRestore(work)} />
            {failure ? (
              <div className="px-2">
                <WorkCommandFailureRow failure={failure} />
              </div>
            ) : null}
          </>
        ),
      }))}
    />
  );
}

function DeletedRow({ work, onRestore }: { work: Work; onRestore: () => void }) {
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-3 px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-muted-foreground">
          {work.name}
        </span>
      </div>
      <button
        type="button"
        onClick={onRestore}
        aria-label={t`Restore ${work.name}`}
        className="text-button shrink-0 text-sm coarse:min-h-11"
      >
        <Trans>Restore</Trans>
      </button>
    </div>
  );
}
