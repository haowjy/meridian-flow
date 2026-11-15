/**
 * The project-create command kind. The command driver delivers it (journal, lookup after a lost
 * answer, resend under the same id); this file says what it sends, what a record means to a
 * screen, and what settling it does to this tab's data. A project with an unsettled or refused
 * create is not on the server yet, so its reads wait (`project-read-gate`).
 */
import type { CommandDriver, CommandKind, CommandRecord } from "@meridian/command-driver";
import type { StoredResult } from "@meridian/contracts/commands";
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { API_PROJECTS_PATH } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import type { CommandDomain } from "@/client/commands/driver-context";
import { upsertProjectInList } from "./project-list-cache";
import { projectIdOfQueryKey, projectQueryKeys } from "./project-query-keys";

export const PROJECT_CREATE_KIND = "project_create";

/** What the record stores: the identity the client minted, so a resend creates the same project. */
export type ProjectCreateBody = { id: string; title: string; userId: string };

/** The create's own answer is the project; the stored outcome of one wraps it as `{ project }`. */
type ProjectResult = Project | (StoredResult & { project?: Project });

export type ProjectCreation = {
  /** The driver record's id. */
  recordId: string;
  projectId: string;
  title: string;
  /** `sending`: on its way. `never`: the server turned it away. `done`: the server has it. */
  state: CommandRecord["state"];
  /** The project the server returned; set once `done`. */
  project?: Project;
  /** The error code of the attempt the server turned away. */
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

/** The project as the writer asked for it, shown until the server returns its own. */
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
    isPersonal: false,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/** The project's create the server has not taken: on its way, or refused and not yet retried or discarded. */
export function unsettledProjectCreation(
  records: readonly CommandRecord[],
  projectId: string,
): ProjectCreation | undefined {
  const creation = projectCreationFor(records, projectId);
  return creation?.state === "done" ? undefined : creation;
}

/** The project's create, in whatever state the driver holds it. */
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

/**
 * The driver each account runs in this tab, for the loader and the read gate, which run outside
 * React. The loader asks for its own account's: during an account switch it runs before the new
 * provider mounts, while the old account's driver is still the mounted one.
 */
type AccountJournal = { driver: CommandDriver | null; opened: Deferred };
type Deferred = { promise: Promise<void>; resolve: () => void };

const journals = new Map<string, AccountJournal>();
/** The account whose provider is mounted: the one the read gate's queries belong to. */
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

/** The account's unsent create of this project, if its driver is bound. */
function pendingCreationIn(
  accountId: string | null,
  projectId: string,
): ProjectCreation | undefined {
  const driver = accountId === null ? undefined : journals.get(accountId)?.driver;
  return driver ? unsettledProjectCreation(driver.getSnapshot().records, projectId) : undefined;
}

/** For the read gate: the mounted account's create of this project the server has not taken. */
export const readPendingProjectCreation = (projectId: string) =>
  pendingCreationIn(mountedAccount, projectId);

/**
 * For the route loader: the account's unsent create of the project, read once that account's
 * journal has opened (it is local and quick), so a reload shows the project as pending the way
 * the first load did. The server has no journal: there the answer is "unknown" (`undefined`).
 */
export async function awaitPendingProjectCreation(
  accountId: string,
  projectId: string,
): Promise<ProjectCreation | undefined> {
  if (typeof window === "undefined") return undefined;
  await journalOf(accountId).opened.promise;
  return pendingCreationIn(accountId, projectId);
}

export function projectDomain(client: QueryClient): CommandDomain {
  const kinds: Record<string, CommandKind> = {
    [PROJECT_CREATE_KIND]: {
      version: 1,
      migrate: (body) => body as ProjectCreateBody,
      // The project's Work commands wait for it to succeed, through a refusal and its Retry.
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
  };
  return {
    kinds,
    bind: (driver, accountId, opened = Promise.resolve()) => {
      const journal = journalOf(accountId);
      journal.driver = driver;
      mountedAccount = accountId;
      // A journal that cannot be read leaves no creations to find, and the loader goes on.
      const { resolve } = journal.opened;
      void opened.then(resolve, resolve);
      return () => {
        if (journal.driver !== driver) return;
        journal.driver = null;
        journal.opened = deferred();
        if (mountedAccount === accountId) mountedAccount = null;
      };
    },
  };
}
