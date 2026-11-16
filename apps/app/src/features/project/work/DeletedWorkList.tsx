/**
 * The Work list's Deleted tab: soft-deleted Works stay restorable, with
 * everything that went with them, until the server purges them. Each row
 * restores in place; a Work found purged keeps its row, saying so, until dismissed.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { withGone } from "@/components/app/RowWord";
import { WorkHandle } from "@/components/app/WorkIdentity";
import { ListLine } from "@/components/ui/list-row";
import { nameWithHandle, type WorkHandleOf } from "@/lib/work-name";
import { RuledList } from "../RuledList";
import { GoneWord } from "./GoneWord";
import { type WorkPlace, workPlace } from "./useWorkDeletion";
import { WorkCommandFailureRow } from "./WorkCommandFailureRow";
import type { GoneEntry, ListedWorkEntry } from "./work-list-model";

export function DeletedWorkList({
  entries,
  handleOf,
  list,
  onRestore,
}: {
  entries: readonly (ListedWorkEntry | GoneEntry)[];
  handleOf: WorkHandleOf;
  /** This list's name, for the place a restored row leaves. */
  list: string;
  onRestore: (work: Work, place: WorkPlace) => void;
}) {
  if (!entries.length)
    return (
      <div className="px-0.5">
        <ListLine>
          <Trans>Deleted Work can be restored.</Trans>
        </ListLine>
      </div>
    );
  const listed = entries.filter((entry): entry is ListedWorkEntry => entry.state !== "gone");
  const gone = entries.filter((entry): entry is GoneEntry => entry.state === "gone");
  const ids = listed.map((entry) => entry.work.id);
  return (
    <RuledList
      rows={withGone(
        listed,
        (entry) => entry.key,
        gone.map((entry) => ({
          key: entry.key,
          row: entry,
          after: workPlace(entry.work.id)?.after ?? [],
        })),
      ).map(({ row: entry, key }) => ({
        key,
        node:
          entry.state === "gone" ? (
            <DeletedRow
              name={entry.work.name}
              handle={handleOf(entry.work)}
              word={<GoneWord entry={entry} />}
            />
          ) : (
            <>
              <DeletedRow
                name={entry.work.name}
                handle={handleOf(entry.work)}
                word={
                  <button
                    type="button"
                    onClick={() =>
                      onRestore(entry.work, {
                        list,
                        after: ids.slice(0, ids.indexOf(entry.work.id)).reverse(),
                      })
                    }
                    aria-label={t`Restore ${nameWithHandle(entry.work.name, handleOf(entry.work))}`}
                    className="text-button shrink-0 text-sm coarse:min-h-11"
                  >
                    <Trans>Restore</Trans>
                  </button>
                }
              />
              {entry.failure ? (
                <div className="px-2">
                  <WorkCommandFailureRow failure={entry.failure} />
                </div>
              ) : null}
            </>
          ),
      }))}
    />
  );
}

function DeletedRow({
  name,
  handle,
  word,
}: {
  name: string;
  handle: string | null;
  word: React.ReactNode;
}) {
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-3 px-2 py-1.5">
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-sm font-medium text-muted-foreground">{name}</span>
        <WorkHandle handle={handle} />
      </div>
      {word}
    </div>
  );
}
