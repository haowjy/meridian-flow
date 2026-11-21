/**
 * Work command records read against the server snapshot: the snapshot with
 * every unsettled command laid over it, the Works still being created beside
 * it, and whether the snapshot already shows what a command asked for.
 */
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import type { Work, WorksSnapshot } from "@meridian/contracts/works";

import {
  type WorkCommandRecord,
  type WorkCommandVariables,
  workCommandSpecs,
} from "./work-commands";

/** A Work the server has not created yet, as the writer asked for it. */
export type UncreatedWork = Pick<Work, "name" | "goal" | "lastActivityAt"> & {
  id: ParsedRequestId;
  draftId: string;
};

/**
 * A Work the server has not created yet: pending while its create is on its
 * way, failed once the server turned it away.
 */
export type WorkCreation = { work: UncreatedWork; phase: "pending" | "failed" };

function uncreatedWork(
  { workId, draftId, name, goal }: WorkCommandVariables["create"],
  submittedAt: number,
): UncreatedWork {
  return { id: workId, draftId, name, goal: goal ?? null, lastActivityAt: isoAt(submittedAt) };
}

const isoAt = (time: number) => new Date(time).toISOString();

/**
 * The server snapshot with every unsettled command laid over it, oldest first: what it expects
 * before the server answers, what the server returned after, until a read that started after
 * it settled has come back (`observed`). A create shows as a `WorkCreation` until the server has
 * the Work, then first in the list, where the server's newest-first order will put it. A Work
 * being created shows even before the first snapshot loads.
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
    const refused = record.state === "never" && record.operation === "create";
    if (record.state === "never" ? !refused : record.state === "done" && record.observed) continue;
    changed = true;
    const before = byId.get(record.workId);
    if (!before && record.operation === "create" && record.state !== "done") {
      creations.set(record.workId, {
        work: uncreatedWork(record.variables, record.since),
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
function recordProjection(work: Work | undefined, record: WorkCommandRecord): Work | undefined {
  const spec = workCommandSpecs[record.operation] as {
    project: (w: Work | undefined, v: unknown, c: { at: string }) => Work | undefined;
    commit: (w: Work | undefined, v: unknown, c: Work | undefined) => Work | undefined;
  };
  if (record.state === "done") return spec.commit(work, record.variables, record.committed);
  return spec.project(work, record.variables, { at: isoAt(record.since) });
}

/** Whether the server snapshot already shows what this command asked for. */
export function snapshotHasCommandTarget(
  snapshot: WorksSnapshot | undefined,
  command: Pick<WorkCommandRecord, "operation" | "variables">,
): boolean {
  if (!snapshot) return false;
  const { workId } = command.variables;
  const work =
    snapshot.noWork.id === workId
      ? snapshot.noWork
      : snapshot.works.find((entry) => entry.id === workId);
  return (
    workCommandSpecs[command.operation].reached as (w: Work | undefined, v: unknown) => boolean
  )(work, command.variables);
}
