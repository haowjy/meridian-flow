import { isWorkArchived, type Work } from "@meridian/contracts/works";
import type { AddressableWork } from "@/client/query/useWorks";
import type { UncreatedWork, WorkCreation } from "@/client/query/work-command-projection";
import type { WorkDeleteWindow } from "@/client/query/work-command-selectors";
import type { WorkPlace } from "./useWorkDeletion";
import type { WorkRowFailure } from "./WorkCommandFailureRow";

export type ArchiveTab = "active" | "archived";

export const archiveTab = (work: Pick<Work, "archivedAt">): ArchiveTab =>
  isWorkArchived(work) ? "archived" : "active";

export type WorkListEntry = { key: string; failure?: WorkRowFailure } & (
  | { state: "creating" | "notCreated"; work: UncreatedWork }
  | { state: "restoring" | "undo" | "idle"; work: AddressableWork }
  | { state: "gone"; work: GoneWork }
);

export type GoneWork = { id: string; name: string };

export type ListedWorkEntry = Extract<WorkListEntry, { work: AddressableWork }>;

export type GoneEntry = Extract<WorkListEntry, { state: "gone" }>;

export type WorkListProjection = {
  works: readonly AddressableWork[];
  deleted: readonly AddressableWork[];
  creations: ReadonlyMap<string, WorkCreation>;
  restoring: ReadonlySet<string>;
};

export function workListEntries(
  projected: WorkListProjection,
  windows: readonly WorkDeleteWindow[],
  failures: ReadonlyMap<string, WorkRowFailure>,
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
