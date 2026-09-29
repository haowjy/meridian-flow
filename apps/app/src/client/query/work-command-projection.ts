/**
 * Work command records read against the server snapshot: the snapshot with
 * every pending command laid over it, the Works still being created beside
 * it, and whether the snapshot already shows what a command asked for.
 */
import type { Work, WorksSnapshot } from "@meridian/contracts/works";

import {
  type CommandOf,
  type RecordOf,
  type WorkCommandRecord,
  type WorkCommandVariables,
  type WorkOperation,
  workCommandSpecs,
} from "./work-commands";

/** A Work the server has not created yet, as the writer asked for it. */
export type WorkDraft = Pick<Work, "id" | "name" | "goal" | "lastActivityAt">;

/**
 * A Work the server has not created yet: pending while its create is on its
 * way, failed once it was refused.
 */
export type WorkCreation = { work: WorkDraft; phase: "pending" | "failed" };

function draftWork(
  { workId, name, goal }: WorkCommandVariables["create"],
  submittedAt: number,
): WorkDraft {
  return { id: workId, name, goal: goal ?? null, lastActivityAt: isoAt(submittedAt) };
}

const isoAt = (time: number) => new Date(time).toISOString();

/**
 * The server snapshot with every pending command laid over it, oldest first:
 * what it expects before the server answers, what the server returned after.
 * A create shows as a `WorkCreation` until the server has the Work, then
 * first in the list, where the server's newest-first order will put it. A
 * Work being created shows even before the first snapshot loads.
 */
export function projectWorkCommands(
  snapshot: WorksSnapshot | undefined,
  records: readonly WorkCommandRecord[],
): { snapshot: WorksSnapshot | undefined; creations: ReadonlyMap<string, WorkCreation> } {
  const byId = new Map<string, Work>();
  if (snapshot) for (const work of [...snapshot.works, snapshot.noWork]) byId.set(work.id, work);
  const creations = new Map<string, WorkCreation>();
  const created: string[] = [];
  let changed = false;
  for (const record of records) {
    const refused = record.status === "failed" && record.operation === "create";
    if (record.status !== "pending" && !refused) continue;
    changed = true;
    const before = byId.get(record.workId);
    if (!before && record.operation === "create" && !record.committed) {
      creations.set(record.workId, {
        work: draftWork(record.variables, record.submittedAt),
        phase: refused ? "failed" : "pending",
      });
      continue;
    }
    const after = recordProjection(before, record);
    if (!after) continue;
    byId.set(record.workId, after);
    if (!before) created.unshift(record.workId);
  }
  if (!changed || !snapshot) return { snapshot, creations };
  // Commands keep the catalog fields a snapshot entry carries.
  const pick = (id: string) => byId.get(id) as WorksSnapshot["works"][number];
  return {
    snapshot: {
      ...snapshot,
      works: [...created.map(pick), ...snapshot.works.map((work) => pick(work.id))],
      noWork: byId.get(snapshot.noWork.id) as WorksSnapshot["noWork"],
    },
    creations,
  };
}

/** The Work as one record leaves it. */
export function recordProjection<Op extends WorkOperation>(
  work: Work | undefined,
  record: RecordOf<Op>,
): Work | undefined {
  const spec = workCommandSpecs[record.operation];
  if (record.committed) return spec.commit(work, record.variables, record.committed.result);
  return spec.project(work, record.variables, { at: isoAt(record.submittedAt) });
}

/** Whether the server snapshot already shows what this command asked for. */
export function snapshotHasCommandTarget<Op extends WorkOperation>(
  snapshot: WorksSnapshot | undefined,
  command: CommandOf<Op>,
): boolean {
  if (!snapshot) return false;
  const { workId } = command.variables;
  const work =
    snapshot.noWork.id === workId
      ? snapshot.noWork
      : snapshot.works.find((entry) => entry.id === workId);
  return workCommandSpecs[command.operation].reached(work, command.variables);
}
