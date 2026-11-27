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
import { refreshRouteThreadsSince } from "./project-route-data";
import { convergeWorkProjection } from "./work-projection-cache";
import { observeWorksReads, refreshWorksSnapshotSince } from "./works-projection-acquisition";

export type WorkCommandVariables = {
  create: { workId: ParsedRequestId; draftId: string; name: string; goal?: string };
  update: { workId: string; data: UpdateWorkRequest };
  archive: { workId: string };
  unarchive: { workId: string };
  delete: { workId: string };
  restore: { workId: string; name?: string };
};

export type ReturnedWhy = Extract<Settlement, { rule: "returned" }>["why"];

export type WorkOperation = keyof WorkCommandVariables;

export type WorkCommandBody<Op extends WorkOperation = WorkOperation> = {
  projectId: string;
  variables: WorkCommandVariables[Op];
};

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
  project: (
    work: Work | undefined,
    variables: WorkCommandVariables[Op],
    context: { at: string },
  ) => Work | undefined;
  commit: (
    work: Work | undefined,
    variables: WorkCommandVariables[Op],
    committed: Work | undefined,
  ) => Work | undefined;
  reached: (work: Work | undefined, variables: WorkCommandVariables[Op]) => boolean;
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

export const workCommandSpecs: { [Op in WorkOperation]: WorkCommandSpec<Op> } = workCommands;

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

export const workKindOf = (operation: WorkOperation): string => KINDS[operation];

export const WORK_KINDS: ReadonlySet<string> = new Set(Object.values(KINDS));

type ViewOf<Op extends WorkOperation> = {
  id: string;
  operation: Op;
  projectId: string;
  variables: WorkCommandVariables[Op];
  workId: string;
  state: CommandRecord["state"];
  observed: boolean;
  since: number;
  committed?: Work;
  returned: ReturnedWhy | null;
  code: string | null;
};

export type WorkCommandRecord = { [Op in WorkOperation]: ViewOf<Op> }[WorkOperation];

const OPERATION_OF = Object.fromEntries(
  Object.entries(KINDS).map(([operation, kind]) => [kind, operation]),
) as Record<string, WorkOperation>;

type StoredWork = StoredResult & { work?: Work; refusal?: { error: string } };
type WorkResult = WorkAnswer | StoredWork;

const isAnswer = (result: WorkResult): result is WorkAnswer => "id" in result;

const locked = (result: unknown) => (result as StoredWork | undefined)?.refusal?.error === "locked";

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

export function workDomain(client: QueryClient): CommandDomain {
  const opened = Date.now();
  const settled = (record: CommandRecord, operation: WorkOperation) => {
    const { projectId } = record.body as WorkCommandBody;
    const since = record.settledAt ?? Date.now();
    void refreshWorksSnapshotSince(client, projectId, since);
    if (since > opened) convergeWorkProjection(client, { kind: "entity", projectId, operation });
    else refreshRouteThreadsSince(client, projectId, since);
  };
  const kinds: Record<string, CommandKind> = {};
  for (const operation of Object.keys(KINDS) as WorkOperation[]) {
    kinds[KINDS[operation]] = {
      version: 1,
      migrate: (body) => body as WorkCommandBody,
      request: ({ body }) => workCommandSpecs[operation].request(body as never),
      onSettled: (record) => settled(record, operation),
    };
  }
  return { kinds, bind: (driver) => observeWorksReads(client, driver) };
}
