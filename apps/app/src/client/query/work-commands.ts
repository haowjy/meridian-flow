/**
 * The Work command table. One entry per operation says what it sends, what it
 * shows while pending, which fields it owns once committed, when the server
 * already shows it, and how it runs. The record store
 * (`work-command-store`) runs commands from it; the projection
 * (`work-command-projection`) reads records against the server snapshot.
 */
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { isWorkArchived, type UpdateWorkRequest, type Work } from "@meridian/contracts/works";

import {
  archiveWork,
  createProjectWork,
  deleteWork,
  listProjectWorks,
  restoreWork,
  unarchiveWork,
  updateWork,
} from "@/client/api/projects-api";
import { createWithRecovery } from "@/client/creation/creation-registry";

export type WorkCommandVariables = {
  create: { workId: ParsedRequestId; name: string; goal?: string };
  update: { workId: string; data: UpdateWorkRequest };
  archive: { workId: string };
  unarchive: { workId: string };
  delete: { workId: string };
  restore: { workId: string };
};

export type WorkOperation = keyof WorkCommandVariables;

type WorkCommandResults = {
  create: Work;
  update: Work;
  archive: Work;
  unarchive: Work;
  delete: unknown;
  restore: Work;
};

type CommandContext = { projectId: string; signal: AbortSignal | undefined };

type WorkCommandSpec<Op extends WorkOperation> = {
  request: (
    variables: WorkCommandVariables[Op],
    context: CommandContext,
  ) => Promise<WorkCommandResults[Op]>;
  /** The Work as this command expects to leave it, before the server answers. */
  project: (
    work: Work | undefined,
    variables: WorkCommandVariables[Op],
    context: { at: string },
  ) => Work | undefined;
  /** The Work with the committed fields this command owns, as the server returned them. */
  commit: (
    work: Work | undefined,
    variables: WorkCommandVariables[Op],
    committed: WorkCommandResults[Op],
  ) => Work | undefined;
  /** Whether the server snapshot already shows what this command asked for. */
  reached: (work: Work | undefined, variables: WorkCommandVariables[Op]) => boolean;
  /** Runs one at a time on the network with the project's other serial commands. */
  serial: boolean;
  /**
   * A refusal stays as a record for a surface to show. Otherwise its caller
   * reports it from the command's own promise, and the record goes at once.
   */
  keepsFailure: boolean;
};

const patch = (work: Work | undefined, fields: Partial<Work>): Work | undefined =>
  work && { ...work, ...fields };

const workCommands = {
  create: {
    // A lost POST response is recovered by the Work's own id.
    request: ({ workId, name, goal }, { projectId, signal }) =>
      createWithRecovery(
        () => createProjectWork(projectId, { id: workId, name, goal }, { signal }),
        async () =>
          (await listProjectWorks(projectId, { signal })).works.find(
            (work) => work.id === workId,
          ) ?? null,
      ),
    // Until the server has it, the Work shows only as a `WorkCreation`.
    project: (work) => work,
    // A new Work has nothing unpushed yet.
    commit: (work, _, committed) =>
      work ?? { ...committed, unpushedChangeCount: committed.unpushedChangeCount ?? 0 },
    reached: (work) => !!work,
    serial: false,
    keepsFailure: true,
  },
  update: {
    request: ({ workId, data }, { signal }) => updateWork(workId, data, { signal }),
    project: (work, { data }, { at }) => patch(work, { ...data, updatedAt: at }),
    commit: (work, { data }, committed) =>
      patch(
        work,
        Object.fromEntries(Object.keys(data).map((key) => [key, committed[key as keyof Work]])),
      ),
    reached: (work, { data }) =>
      !!work && Object.entries(data).every(([key, value]) => work[key as keyof Work] === value),
    serial: false,
    // A rename reopens its own field on failure.
    keepsFailure: false,
  },
  archive: {
    request: ({ workId }, { signal }) => archiveWork(workId, { signal }),
    project: (work, _, { at }) => patch(work, { archivedAt: at }),
    commit: (work, _, { archivedAt }) => patch(work, { archivedAt }),
    reached: (work) => !!work && isWorkArchived(work),
    serial: true,
    keepsFailure: true,
  },
  unarchive: {
    request: ({ workId }, { signal }) => unarchiveWork(workId, { signal }),
    project: (work) => patch(work, { archivedAt: null }),
    commit: (work, _, { archivedAt }) => patch(work, { archivedAt }),
    reached: (work) => !!work && !isWorkArchived(work),
    serial: true,
    keepsFailure: true,
  },
  delete: {
    request: ({ workId }, { signal }) => deleteWork(workId, { signal }),
    project: (work, _, { at }) => patch(work, { deletedAt: at }),
    // The server returns nothing: the client clock stands in for the delete
    // time, so the purge countdown is approximate until the next read.
    commit: (work) => patch(work, { deletedAt: work?.deletedAt ?? new Date().toISOString() }),
    reached: (work) => !work || work.deletedAt !== null,
    serial: true,
    keepsFailure: true,
  },
  restore: {
    request: ({ workId }, { signal }) => restoreWork(workId, { signal }),
    project: (work) => patch(work, { deletedAt: null }),
    commit: (work, _, { deletedAt }) => patch(work, { deletedAt }),
    reached: (work) => !!work && work.deletedAt === null,
    serial: true,
    keepsFailure: true,
  },
} satisfies { [Op in WorkOperation]: WorkCommandSpec<Op> };

/** Indexed through the mapped type so a generic operation keeps its own spec. */
export const workCommandSpecs: { [Op in WorkOperation]: WorkCommandSpec<Op> } = workCommands;

export type CommandOf<Op extends WorkOperation> = {
  operation: Op;
  variables: WorkCommandVariables[Op];
};

/** One Work command with its own variables. */
export type WorkCommand = { [Op in WorkOperation]: CommandOf<Op> }[WorkOperation];

export type RecordOf<Op extends WorkOperation> = CommandOf<Op> & {
  id: number;
  workId: string;
  submittedAt: number;
  /** `done` is a delete that landed: its Undo window. */
  status: "pending" | "failed" | "done";
  /** The writer closed it: a pending delete's Undo window. */
  dismissed: boolean;
  error: Error | null;
  /** What the server returned; set once the command committed. */
  committed?: { result: WorkCommandResults[Op] };
};

export type WorkCommandRecord = { [Op in WorkOperation]: RecordOf<Op> }[WorkOperation];

/** A command resolves to its failure, or `null` once the server has it. */
export type RunWorkCommand<Op extends WorkOperation> = (
  variables: WorkCommandVariables[Op],
) => Promise<Error | null>;

export type WorkMutations = { [Op in WorkOperation]: RunWorkCommand<Op> };
