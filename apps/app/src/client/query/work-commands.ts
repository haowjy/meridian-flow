/**
 * The Work command table. One entry per operation says what it sends, what it shows while the
 * command is unsettled, which fields it owns once the server has answered, and when the server
 * snapshot already shows it. The command driver delivers each as a record of its own kind
 * (`createWorkKinds`); `work-command-projection` lays the records over the server snapshot.
 */
import type { CommandKind, CommandRecord, HttpRequest } from "@meridian/command-driver";
import type { Settlement, StoredResult } from "@meridian/contracts/commands";
import { apiProjectWorksPath } from "@meridian/contracts/protocol";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import {
  isWorkArchived,
  type UpdateWorkRequest,
  type Work,
  type WorkAnswer,
} from "@meridian/contracts/works";
import type { QueryClient } from "@tanstack/react-query";

import type { CommandDomain } from "@/client/commands/driver-context";
import { projectLane, unsettledProjectCreation } from "./project-commands";
import { convergeWorkProjection } from "./work-projection-cache";
import { observeWorksReads, refreshWorksSnapshot } from "./works-projection-acquisition";

export type WorkCommandVariables = {
  /** `draftId` is the Work's draft, minted with `workId`. */
  create: { workId: ParsedRequestId; draftId: string; name: string; goal?: string };
  update: { workId: string; data: UpdateWorkRequest };
  archive: { workId: string };
  unarchive: { workId: string };
  delete: { workId: string };
  /** `name`: the Work as the writer saw it, for the row a restore that finds it gone leaves. */
  restore: { workId: string; name?: string };
};

/** How a closed Work turned a command away. */
export type ReturnedWhy = Extract<Settlement, { rule: "returned" }>["why"];

export type WorkOperation = keyof WorkCommandVariables;

/** What a Work record stores: the project (a refresh needs it) and the writer's variables. */
export type WorkCommandBody<Op extends WorkOperation = WorkOperation> = {
  projectId: string;
  variables: WorkCommandVariables[Op];
};

/** The server's names for the kinds, which `resolve` is told. */
const KINDS = {
  create: "work_create",
  update: "work_update",
  archive: "work_archive",
  unarchive: "work_unarchive",
  delete: "work_delete",
  restore: "work_restore",
} as const satisfies Record<WorkOperation, string>;

type WorkCommandSpec<Op extends WorkOperation> = {
  request: (body: WorkCommandBody<Op>) => HttpRequest;
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
    committed: Work | undefined,
  ) => Work | undefined;
  /** Whether the server snapshot already shows what this command asked for. */
  reached: (work: Work | undefined, variables: WorkCommandVariables[Op]) => boolean;
  /**
   * A refusal stays as a record for a surface to show. Otherwise its caller
   * reports it from the command's own promise, and the record goes at once.
   */
  keepsFailure: boolean;
};

const patch = (work: Work | undefined, fields: Partial<Work>): Work | undefined =>
  work && { ...work, ...fields };

const worksPath = (workId: string, action = "") => `/api/works/${workId}${action}`;

const workCommands = {
  create: {
    request: ({ projectId, variables: { workId, draftId, name, goal } }) => ({
      method: "POST",
      path: apiProjectWorksPath(projectId),
      body: { id: workId, draftId, name, goal },
    }),
    // Until the server has it, the Work shows only as a `WorkCreation`.
    project: (work) => work,
    commit: (work, _, committed) => work ?? committed,
    reached: (work) => !!work,
    keepsFailure: true,
  },
  update: {
    request: ({ variables: { workId, data } }) => ({
      method: "PATCH",
      path: worksPath(workId),
      body: { ...data },
    }),
    project: (work, { data }, { at }) => patch(work, { ...data, updatedAt: at }),
    commit: (work, { data }, committed) =>
      committed &&
      patch(
        work,
        Object.fromEntries(Object.keys(data).map((key) => [key, committed[key as keyof Work]])),
      ),
    reached: (work, { data }) =>
      !!work && Object.entries(data).every(([key, value]) => work[key as keyof Work] === value),
    // A rename reopens its own field on failure.
    keepsFailure: false,
  },
  archive: {
    request: ({ variables: { workId } }) => ({
      method: "POST",
      path: worksPath(workId, "/archive"),
      body: {},
    }),
    project: (work, _, { at }) => patch(work, { archivedAt: at }),
    commit: (work, _, committed) => committed && patch(work, { archivedAt: committed.archivedAt }),
    reached: (work) => !!work && isWorkArchived(work),
    keepsFailure: true,
  },
  unarchive: {
    request: ({ variables: { workId } }) => ({
      method: "POST",
      path: worksPath(workId, "/unarchive"),
      body: {},
    }),
    project: (work) => patch(work, { archivedAt: null }),
    commit: (work, _, committed) => committed && patch(work, { archivedAt: committed.archivedAt }),
    reached: (work) => !!work && !isWorkArchived(work),
    keepsFailure: true,
  },
  delete: {
    request: ({ variables: { workId } }) => ({
      method: "DELETE",
      path: worksPath(workId),
      body: {},
    }),
    project: (work, _, { at }) => patch(work, { deletedAt: at }),
    // The server returns nothing: the client clock stands in for the delete
    // time, so the purge countdown is approximate until the next read.
    commit: (work) => patch(work, { deletedAt: work?.deletedAt ?? new Date().toISOString() }),
    reached: (work) => !work || work.deletedAt !== null,
    keepsFailure: true,
  },
  restore: {
    request: ({ variables: { workId } }) => ({
      method: "POST",
      path: worksPath(workId, "/restore"),
      body: {},
    }),
    project: (work) => patch(work, { deletedAt: null }),
    commit: (work, _, committed) => committed && patch(work, { deletedAt: committed.deletedAt }),
    reached: (work) => !!work && work.deletedAt === null,
    keepsFailure: true,
  },
} satisfies { [Op in WorkOperation]: WorkCommandSpec<Op> };

/** Indexed through the mapped type so a generic operation keeps its own spec. */
export const workCommandSpecs: { [Op in WorkOperation]: WorkCommandSpec<Op> } = workCommands;

/**
 * What a Work command waits behind. Every one waits for its Work's earlier commands; the
 * lifecycle moves (archive, unarchive, delete, restore) also take their project's turn, so they
 * run one at a time per project. While the project's own create has not succeeded
 * (`records` hold one), the command also waits on its lane: the server has no such project, and a
 * refused create keeps the lane closed until it is retried or discarded.
 */
export const workLanes = (
  operation: WorkOperation,
  projectId: string,
  workId: string,
  records: readonly CommandRecord[],
): string[] => [
  `work:${workId}`,
  ...(operation === "create" || operation === "update" ? [] : [`project-works:${projectId}`]),
  ...(unsettledProjectCreation(records, projectId) ? [projectLane(projectId)] : []),
];

/** The kind a Work operation is stored and delivered as. */
export const workKindOf = (operation: WorkOperation): string => KINDS[operation];

export const WORK_KINDS: ReadonlySet<string> = new Set(Object.values(KINDS));

/** A Work command as the screens read it: a driver record in the Work's own terms. */
type ViewOf<Op extends WorkOperation> = {
  /** The driver record's id. */
  id: string;
  operation: Op;
  projectId: string;
  variables: WorkCommandVariables[Op];
  workId: string;
  state: CommandRecord["state"];
  /** A read of the Works started after this settled `done` has included it. */
  observed: boolean;
  since: number;
  /** The Work the server returned; set once the command is `done`. */
  committed?: Work;
  /**
   * Set when the server answered `done` but changed nothing because the Work is closed
   * (`settled: [{ rule: "returned", why }]`). The result is then the Work as it stands, so
   * projecting it puts the subject back.
   */
  returned: ReturnedWhy | null;
  /** The error code of the attempt the server turned away (`work_locked`, `work_not_found`). */
  code: string | null;
};

export type WorkCommandRecord = { [Op in WorkOperation]: ViewOf<Op> }[WorkOperation];

const OPERATION_OF = Object.fromEntries(
  Object.entries(KINDS).map(([operation, kind]) => [kind, operation]),
) as Record<string, WorkOperation>;

/** What a Work command's outcome carries: the Work route's own body, or the stored result of one. */
type StoredWork = StoredResult & { work?: Work; refusal?: { error: string } };
type WorkResult = WorkAnswer | StoredWork;

const isAnswer = (result: WorkResult): result is WorkAnswer => "id" in result;

/** A refusal stored with the command: the only one a Work command still has. */
const locked = (result: unknown) => (result as StoredWork | undefined)?.refusal?.error === "locked";

/** The Work view of a driver record; null for another domain's. */
export function workCommandOf(record: CommandRecord): WorkCommandRecord | null {
  const operation = OPERATION_OF[record.kind];
  if (!operation) return null;
  const body = record.body as WorkCommandBody;
  const result = record.outcome ? (record.outcome.result as WorkResult | null) : null;
  const done = record.state === "done" && result ? result : null;
  const committed = done && (isAnswer(done) ? done : done.work);
  const settled: Settlement[] | undefined = done?.settled;
  const returned = settled?.find((entry) => entry.rule === "returned");
  const refused = record.outcome?.status === "never" ? record.outcome : null;
  return {
    id: record.id,
    operation,
    projectId: body.projectId,
    variables: body.variables,
    workId: body.variables.workId,
    state: record.state,
    observed: record.observed,
    since: record.since,
    committed: committed?.id ? committed : undefined,
    returned: returned?.why ?? null,
    code: refused?.code ?? (refused && locked(refused.result) ? "work_locked" : null),
  } as WorkCommandRecord;
}

/**
 * The Work kinds, and the binding that tells the driver which Work outcomes each read of this
 * tab's Works included. Every tab runs `onSettled` for each Work record it sees settle:
 * converge what a Work change touches and read the Works again.
 */
export function workDomain(client: QueryClient): CommandDomain {
  const kinds: Record<string, CommandKind> = {};
  for (const operation of Object.keys(KINDS) as WorkOperation[]) {
    kinds[KINDS[operation]] = {
      version: 1,
      migrate: (body) => body as WorkCommandBody,
      request: ({ body }) => workCommandSpecs[operation].request(body as never),
      onSettled: (record) => {
        const { projectId } = record.body as WorkCommandBody;
        convergeWorkProjection(client, { kind: "entity", projectId, operation });
        void refreshWorksSnapshot(client, projectId).then(undefined, () => undefined);
      },
    };
  }
  return { kinds, bind: (driver) => observeWorksReads(client, driver) };
}
