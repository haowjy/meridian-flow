/**
 * The Work list's Deleted tab: soft-deleted Works stay restorable, with
 * everything that went with them, until the server purges them. Each row
 * restores in place; a Work found purged keeps its row, saying so, until dismissed.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { useWorks } from "@/client/query/useWorks";
import { withGone } from "@/components/app/RowWord";
import { WorkName } from "@/components/app/WorkName";
import { ListLine } from "@/components/ui/list-row";
import type { WorkRef } from "@/lib/work-name";
import { RuledList } from "../RuledList";
import { GoneWord } from "./GoneWord";
import { type WorkPlace, workPlace } from "./useWorkDeletion";
import { WorkCommandFailureRow } from "./WorkCommandFailureRow";
import type { GoneEntry, ListedWorkEntry } from "./work-list-model";

export function DeletedWorkList({
  projectId,
  entries,
  list,
  onRestore,
}: {
  projectId: string;
  entries: readonly (ListedWorkEntry | GoneEntry)[];
  /** This list's name, for the place a restored row leaves. */
  list: string;
  onRestore: (work: Work, place: WorkPlace) => void;
}) {
  const { nameOf } = useWorks(projectId);
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
            <DeletedRow work={{ ...entry.work, projectId }} word={<GoneWord entry={entry} />} />
          ) : (
            <>
              <DeletedRow
                work={entry.work}
                word={
                  <button
                    type="button"
                    onClick={() =>
                      onRestore(entry.work, {
                        list,
                        after: ids.slice(0, ids.indexOf(entry.work.id)).reverse(),
                      })
                    }
                    aria-label={t`Restore ${nameOf(entry.work)}`}
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

function DeletedRow({ work, word }: { work: WorkRef; word: React.ReactNode }) {
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-3 px-2 py-1.5">
      <WorkName work={work} className="flex-1 text-sm font-medium text-muted-foreground" />
      {word}
    </div>
  );
}
