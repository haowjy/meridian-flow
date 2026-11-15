/**
 * The Work list's rows per tab, as data: which Work each row shows, in what
 * state, and which refused command it carries. `WorkCollection` only maps
 * these entries to rows.
 */
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import type { AddressableWork } from "@/client/query/useWorks";
import type { UncreatedWork, WorkCreation } from "@/client/query/work-command-projection";
import type { WorkDeleteWindow } from "@/client/query/work-command-selectors";
import type { WorkPlace } from "./useWorkDeletion";
import type { WorkRowFailure } from "./WorkCommandFailureRow";

/** The list tab a Work the server has sits in until it is deleted. */
export type ArchiveTab = "active" | "archived";

export const archiveTab = (work: Pick<Work, "archivedAt">): ArchiveTab =>
  isWorkArchived(work) ? "archived" : "active";

/**
 * `creating` and `notCreated`: the server has no such Work yet, so the row
 * has only its draft. `restoring`: back in its tab before the server answers.
 * `undo`: just deleted, with Undo. `idle`: everything else, including every
 * row of the Deleted tab.
 */
export type WorkListEntry = { key: string; failure?: WorkRowFailure } & (
  | { state: "creating" | "notCreated"; work: UncreatedWork }
  | { state: "restoring" | "undo" | "idle"; work: AddressableWork }
  | { state: "gone"; work: GoneWork }
);

/**
 * A Work a restore found purged (`gone`): the server no longer lists it, so the row is its name and
 * the failure, in the place the Work had until the writer dismisses it.
 */
export type GoneWork = { id: string; name: string };

/** A row of a Work the server has. */
export type ListedWorkEntry = Extract<WorkListEntry, { work: AddressableWork }>;

export type GoneEntry = Extract<WorkListEntry, { state: "gone" }>;

export type WorkListProjection = {
  works: readonly AddressableWork[];
  /** Soft-deleted Works, newest delete first. */
  deleted: readonly AddressableWork[];
  creations: ReadonlyMap<string, WorkCreation>;
  restoring: ReadonlySet<string>;
};

/**
 * Active: Works being created, then each just-deleted Work's Undo row (newest
 * delete first), then the tab's Works; the list puts an Undo row back where its
 * Work was when it can. Archived: its Undo rows, then its Works. Deleted: every
 * deleted Work the server still holds, from the
 * moment it is deleted; a Work with an open Undo row shows in both.
 */
export function workListEntries(
  projected: WorkListProjection,
  windows: readonly WorkDeleteWindow[],
  failures: ReadonlyMap<string, WorkRowFailure>,
  /** Where each Work's row was when it left its list, if it did from this list. */
  placeOf: (workId: string) => WorkPlace | null,
): Record<ArchiveTab, WorkListEntry[]> & { deleted: (ListedWorkEntry | GoneEntry)[] } {
  const known = new Set<string>([...projected.works, ...projected.deleted].map((work) => work.id));
  const goneRows = [...failures.values()].flatMap((failure): GoneEntry[] =>
    failure.operation === "restore" &&
    failure.error.code === "work_not_found" &&
    failure.name !== undefined &&
    !known.has(failure.workId)
      ? [
          {
            key: `gone-${failure.workId}`,
            state: "gone",
            work: { id: failure.workId, name: failure.name },
            failure,
          },
        ]
      : [],
  );
  // A gone row belongs to the tab the Work was deleted from, or else to Deleted.
  const goneIn = (list: string | null) =>
    goneRows.filter(
      (entry) => (placeOf(entry.work.id)?.list.split(":").at(-1) ?? "deleted") === list,
    );
  const listed = (work: AddressableWork): ListedWorkEntry =>
    projected.restoring.has(work.id)
      ? { key: work.id, work, state: "restoring" }
      : { key: work.id, work, state: "idle", failure: failures.get(work.id) };
  const undoRows = (view: ArchiveTab) =>
    [...windows].reverse().flatMap((open): WorkListEntry[] => {
      const work = projected.deleted.find((entry) => entry.id === open.workId);
      if (!work || archiveTab(work) !== view) return [];
      return [{ key: `deleted-${work.id}`, work, state: "undo", failure: failures.get(work.id) }];
    });
  const tab = (view: ArchiveTab) => [
    ...undoRows(view),
    ...projected.works.filter((work) => archiveTab(work) === view).map(listed),
  ];
  const creating = [...projected.creations.values()].map(
    ({ work, phase }): WorkListEntry => ({
      key: work.id,
      work,
      state: phase === "failed" ? "notCreated" : "creating",
    }),
  );
  return {
    active: [...creating, ...tab("active"), ...goneIn("active")],
    archived: [...tab("archived"), ...goneIn("archived")],
    deleted: [
      ...projected.deleted.map(
        (work): ListedWorkEntry => ({
          key: work.id,
          work,
          state: "idle",
          failure: failures.get(work.id),
        }),
      ),
      ...goneIn("deleted"),
    ],
  };
}
