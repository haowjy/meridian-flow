import type { CommandDriver, CommandKind, CommandRecord } from "@meridian/command-driver";
import type { StoredResult } from "@meridian/contracts/commands";
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { API_PROJECTS_PATH, apiProjectPath } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { CommandDomain } from "@/client/commands/driver-context";
import { useCommandDriver } from "@/client/commands/driver-context";
import { upsertProjectInList } from "./project-list-cache";
import { projectIdOfQueryKey, projectQueryKeys } from "./project-query-keys";
import { projectRenames, renameCommand } from "./rename-command";
import { rereadThenObserve } from "./when-read";

export const PROJECT_CREATE_KIND = "project_create";

export const PROJECT_RENAME_KIND = "project_rename";

type ProjectRenameBody = { projectId: string; title: string };

export type ProjectCreateBody = { id: string; title: string; userId: string };

type ProjectResult = Project | (StoredResult & { project?: Project });

export type ProjectCreation = {
  recordId: string;
  projectId: string;
  title: string;
  state: CommandRecord["state"];
  project?: Project;
  code: string | null;
};

export const projectLane = (projectId: string) => `project:${projectId}`;

export function projectCreationOf(record: CommandRecord): ProjectCreation | null {
  if (record.kind !== PROJECT_CREATE_KIND) return null;
  const body = record.body as ProjectCreateBody;
  const result =
    record.state === "done" ? (record.outcome?.result as ProjectResult | undefined) : undefined;
  const project = result && ("project" in result ? result.project : (result as Project));
  return {
    recordId: record.id,
    projectId: body.id,
    title: body.title,
    state: record.state,
    project: project?.id ? project : undefined,
    code: record.outcome?.status === "never" ? (record.outcome.code ?? null) : null,
  };
}

export function pendingProject(
  { id, title, userId }: ProjectCreateBody,
  now = new Date().toISOString(),
): Project {
  return {
    id,
    userId,
    title,
    slug: "",
    description: null,
    settings: {},
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function unsettledProjectCreation(
  records: readonly CommandRecord[],
  projectId: string,
): ProjectCreation | undefined {
  const creation = projectCreationFor(records, projectId);
  return creation?.state === "done" ? undefined : creation;
}

export function projectCreationFor(
  records: readonly CommandRecord[],
  projectId: string,
): ProjectCreation | undefined {
  let found: ProjectCreation | undefined;
  for (const record of records) {
    const creation = projectCreationOf(record);
    if (creation?.projectId === projectId) found = creation;
  }
  return found;
}

type AccountJournal = { driver: CommandDriver | null; opened: Deferred };
type Deferred = { promise: Promise<void>; resolve: () => void };

const journals = new Map<string, AccountJournal>();
let mountedAccount: string | null = null;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function journalOf(accountId: string): AccountJournal {
  const known = journals.get(accountId);
  if (known) return known;
  const journal: AccountJournal = { driver: null, opened: deferred() };
  journals.set(accountId, journal);
  return journal;
}

function pendingCreationIn(
  accountId: string | null,
  projectId: string,
): ProjectCreation | undefined {
  const driver = accountId === null ? undefined : journals.get(accountId)?.driver;
  return driver ? unsettledProjectCreation(driver.getSnapshot().records, projectId) : undefined;
}

export const readPendingProjectCreation = (projectId: string) =>
  pendingCreationIn(mountedAccount, projectId);

export async function awaitPendingProjectCreation(
  accountId: string,
  projectId: string,
): Promise<ProjectCreation | undefined> {
  if (typeof window === "undefined") return undefined;
  await journalOf(accountId).opened.promise;
  return pendingCreationIn(accountId, projectId);
}

export const projectProjectTitles = (records: readonly CommandRecord[], projects: Project[]) =>
  projectRenames(
    records,
    PROJECT_RENAME_KIND,
    (body) => (body as ProjectRenameBody).projectId,
    projects,
  );

export function useRenameProject(projectId: string): (title: string) => Promise<void> {
  const driver = useCommandDriver();
  return useCallback(
    (title: string) =>
      renameCommand(driver, {
        kind: PROJECT_RENAME_KIND,
        lanes: [projectLane(projectId)],
        body: { projectId, title: title.trim() } satisfies ProjectRenameBody,
      }),
    [driver, projectId],
  );
}

export function projectDomain(client: QueryClient): CommandDomain {
  let bound: CommandDriver | null = null;
  const kinds: Record<string, CommandKind> = {
    [PROJECT_CREATE_KIND]: {
      version: 1,
      migrate: (body) => body as ProjectCreateBody,
      holdsLane: true,
      request: ({ body }) => {
        const { id, title } = body as ProjectCreateBody;
        return { method: "POST", path: API_PROJECTS_PATH, body: { id, title } };
      },
      onSettled: (record) => {
        const creation = projectCreationOf(record);
        if (creation?.state !== "done" || !creation.project) return;
        upsertProjectInList(client, creation.project);
        client.setQueryData(projectQueryKeys.detail(creation.projectId), creation.project);
        // A function-valued `enabled` that turns true does not make TanStack fetch: the reads
        // this project's create held back start now.
        void client.refetchQueries({
          type: "active",
          predicate: (query) =>
            projectIdOfQueryKey(query.queryKey) === creation.projectId &&
            query.state.data === undefined,
        });
      },
    },
    [PROJECT_RENAME_KIND]: {
      version: 1,
      migrate: (body) => body as ProjectRenameBody,
      request: ({ body }) => {
        const { projectId, title } = body as ProjectRenameBody;
        return { method: "PATCH", path: apiProjectPath(projectId), body: { title } };
      },
      onSettled: (record) => {
        const { projectId } = record.body as ProjectRenameBody;
        rereadThenObserve(client, bound, (each) => each.id === record.id, [
          { queryKey: projectQueryKeys.list, exact: true },
          { queryKey: projectQueryKeys.detail(projectId), exact: true },
        ]);
      },
    },
  };
  return {
    kinds,
    bind: (driver, accountId, opened = Promise.resolve()) => {
      bound = driver;
      const journal = journalOf(accountId);
      journal.driver = driver;
      mountedAccount = accountId;
      const { resolve } = journal.opened;
      void opened.then(resolve, resolve);
      return () => {
        if (bound === driver) bound = null;
        if (journal.driver !== driver) return;
        journal.driver = null;
        journal.opened = deferred();
        if (mountedAccount === accountId) mountedAccount = null;
      };
    },
  };
}
