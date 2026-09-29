/**
 * The Work list's rows per tab, as data: which Work each row shows, in what
 * state, and which refused command it carries. `WorkCollection` only maps
 * these entries to rows.
 */
import { type Work, workPurgeAt } from "@meridian/contracts/works";
import type { AddressableWork } from "@/client/query/useWorks";
import type { WorkCreation, WorkDraft } from "@/client/query/work-command-projection";
import type { WorkDeleteWindow } from "@/client/query/work-command-selectors";
import type { WorksView } from "../routing/project-address";
import type { WorkRowFailure } from "./WorkCommandFailureRow";

/**
 * `creating` and `notCreated`: the server has no such Work yet, so the row
 * has only its draft. `restoring`: back in its tab before the server answers.
 * `undo`: just deleted, with Undo. `idle`: everything else, including every
 * row of the Deleted tab.
 */
export type WorkListEntry = { key: string; failure?: WorkRowFailure } & (
  | { state: "creating" | "notCreated"; work: WorkDraft }
  | { state: "restoring" | "undo" | "idle"; work: AddressableWork }
);

/** A row of a Work the server has. */
export type ListedWorkEntry = Extract<WorkListEntry, { work: AddressableWork }>;

export type WorkListProjection = {
  works: readonly AddressableWork[];
  /** Soft-deleted Works, newest delete first. */
  deleted: readonly AddressableWork[];
  creations: ReadonlyMap<string, WorkCreation>;
  restoring: ReadonlySet<string>;
};

/**
 * Active: Works being created, then each just-deleted Work's Undo row (newest
 * delete first), then the tab's Works. Archived: its Undo rows, then its
 * Works. Deleted: Works still inside their retention window that are not
 * offered for Undo.
 */
export function workListEntries(
  projected: WorkListProjection,
  windows: readonly WorkDeleteWindow[],
  failures: ReadonlyMap<string, WorkRowFailure>,
  now: number,
): Record<Exclude<WorksView, "deleted">, WorkListEntry[]> & { deleted: ListedWorkEntry[] } {
  const listed = (work: AddressableWork): ListedWorkEntry =>
    projected.restoring.has(work.id)
      ? { key: work.id, work, state: "restoring" }
      : { key: work.id, work, state: "idle", failure: failures.get(work.id) };
  const undoRows = (status: Work["status"]) =>
    [...windows].reverse().flatMap((open): WorkListEntry[] => {
      const work = projected.deleted.find((entry) => entry.id === open.workId);
      if (!work || work.status !== status) return [];
      return [{ key: `deleted-${work.id}`, work, state: "undo", failure: failures.get(work.id) }];
    });
  const tab = (status: Work["status"]) => [
    ...undoRows(status),
    ...projected.works.filter((work) => work.status === status).map(listed),
  ];
  const creating = [...projected.creations.values()].map(
    ({ work, phase }): WorkListEntry => ({
      key: work.id,
      work,
      state: phase === "failed" ? "notCreated" : "creating",
    }),
  );
  const undoable = new Set(windows.map((open) => open.workId));
  return {
    active: [...creating, ...tab("active")],
    archived: tab("archived"),
    deleted: restorableWorks(projected.deleted, now, undoable).map((work) => ({
      key: work.id,
      work,
      state: "idle",
      failure: failures.get(work.id),
    })),
  };
}

/** Deleted Works still inside their retention window, minus those offered for Undo. */
export function restorableWorks<W extends Work>(
  deleted: readonly W[],
  now: number,
  undoable: ReadonlySet<string>,
): W[] {
  return deleted.filter(
    (work) =>
      work.deletedAt !== null &&
      !undoable.has(work.id) &&
      workPurgeAt(work.deletedAt).getTime() > now,
  );
}
