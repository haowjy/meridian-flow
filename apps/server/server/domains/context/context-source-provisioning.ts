/**
 * Provision and resolve Drizzle-backed context_sources rows, producing
 * lazily-cached ContextDocumentStore instances for unified ContextFS schemes.
 *
 * A project's, account's and Work's sources are made in the transaction that makes the project,
 * account or Work, so every tree has its source from the first moment a client can write to it.
 * Only a chat's uploads and a lineage's notes are still made on first write.
 */

import type { ProjectId, ThreadId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { contextSources, projects, works } from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  getDrizzleTransactionLocal,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
  setDrizzleTransactionLocal,
} from "../../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../../shared/work-lifecycle-lock.js";
import {
  DrizzleContextDocumentStore,
  locateDocumentById,
} from "./adapters/context-fs/drizzle-store.js";
import { createDrizzleLineageScratchLifecycle } from "./adapters/lineage-scratch-lifecycle.js";
import type { ContextDocumentStore } from "./ports/context-document-store.js";
import type { ProjectContextFsScheme, WorkScopedContextFsScheme } from "./ports/context-port.js";
import type { ProjectHintPort } from "./ports/project-hints.js";
import type { TreeView } from "./tree/tree-view.js";

const CONTEXT_SOURCE_NAMES: Record<
  ProjectContextFsScheme | WorkScopedContextFsScheme | "uploads",
  string
> = {
  manuscript: "Manuscript",
  kb: "Knowledge Base",
  user: "User Files",
  unfiled: "Unfiled",
  scratch: "Scratch",
  uploads: "Uploads",
};

async function findUserContextProject(db: Database, userId: string): Promise<string | null> {
  const [existing] = await currentDrizzleDb(db)
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.userId, userId), eq(projects.isPersonal, true), isNull(projects.deletedAt)),
    )
    .limit(1);
  return existing?.id ?? null;
}

export async function findNoWorkId(db: Database, projectId: string): Promise<string | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ id: works.id })
    .from(works)
    .where(and(eq(works.projectId, projectId), eq(works.isNoWork, true), isNull(works.deletedAt)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Whether a project-scoped source is stored in the writer's personal project
 * rather than the project being browsed. Its documents belong to that
 * project's live tree, not this one's.
 */
function storedInPersonalProject(scheme: ProjectContextFsScheme): boolean {
  return scheme === "user";
}

type SourceHints = Pick<ProjectHintPort, "publishSourcesHint">;

const PROJECT_SOURCE_SCHEMES = ["manuscript", "kb", "unfiled"] as const;

/**
 * Makes a new project's sources inside its creating transaction. The account's personal project
 * also holds `user://`, the account's own list. Returns the Manuscript source's id.
 */
export async function provisionProjectSources(
  db: Database,
  projectId: string,
  options: { personal: boolean },
): Promise<string> {
  const schemes: ProjectContextFsScheme[] = [
    ...PROJECT_SOURCE_SCHEMES,
    ...(options.personal ? (["user"] as const) : []),
  ];
  const tx = currentDrizzleDb(db);
  // The default bootstrap runs again on a project it already made.
  await tx
    .insert(contextSources)
    .values(
      schemes.map((scheme) => ({
        projectId,
        name: CONTEXT_SOURCE_NAMES[scheme],
        slug: scheme,
        scope: "project" as const,
      })),
    )
    .onConflictDoNothing({
      target: [contextSources.projectId, contextSources.slug],
      where: sql`${contextSources.workId} IS NULL AND ${contextSources.rootThreadId} IS NULL AND ${contextSources.chatThreadId} IS NULL AND ${contextSources.deletedAt} IS NULL`,
    });
  const manuscript = await findProjectContextSource(db, projectId, "manuscript", "");
  if (!manuscript) throw new Error(`Failed to provision sources for project ${projectId}`);
  return manuscript;
}

/** Makes a new Work's Scratch source inside its creating transaction. */
export async function provisionWorkScratch(db: Database, workId: string): Promise<void> {
  await currentDrizzleDb(db).insert(contextSources).values({
    workId,
    name: CONTEXT_SOURCE_NAMES.scratch,
    slug: "scratch",
    scope: "work",
  });
}

/** The reader of a source that provisioning guarantees: its absence is a bug, not a lazy write. */
function required(find: () => Promise<string | null>, what: string): () => Promise<string> {
  return async () => {
    const id = await find();
    if (!id) throw new Error(`The ${what} context source does not exist`);
    return id;
  };
}

async function findProjectContextSource(
  db: Database,
  projectId: string,
  scheme: ProjectContextFsScheme,
  userId: string,
): Promise<string | null> {
  const sourceProjectId = storedInPersonalProject(scheme)
    ? await findUserContextProject(db, userId)
    : projectId;
  if (!sourceProjectId) return null;
  const [row] = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(
      and(
        eq(contextSources.projectId, sourceProjectId),
        eq(contextSources.slug, scheme),
        isNull(contextSources.workId),
        isNull(contextSources.rootThreadId),
        isNull(contextSources.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function findWorkContextSource(
  db: Database,
  workId: string,
  scheme: WorkScopedContextFsScheme,
): Promise<string | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(
      and(
        eq(contextSources.workId, workId),
        eq(contextSources.slug, scheme),
        isNull(contextSources.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

class SourceResolvedContextDocumentStore implements ContextDocumentStore {
  private sourceId: Promise<string> | null = null;
  private readonly transactionSourceIdKey = {};
  private readonly transactionExistingSourceIdKey = {};

  constructor(
    private readonly db: Database,
    private readonly ensureSourceId: () => Promise<string>,
    private readonly findSourceId: () => Promise<string | null>,
    private readonly workId?: string | (() => Promise<string>),
    private readonly beforeWrite?: () => Promise<void>,
  ) {}

  private async resolvedWorkId(): Promise<string | undefined> {
    return typeof this.workId === "function" ? this.workId() : this.workId;
  }

  private async sourceStore(): Promise<DrizzleContextDocumentStore> {
    const sourceId = await runInDrizzleTransaction(this.db, async () => {
      if (this.sourceId) return this.sourceId;
      let pending = getDrizzleTransactionLocal<Promise<string>>(this.transactionSourceIdKey);
      if (!pending) {
        pending = (async () => {
          return this.ensureSourceId();
        })();
        setDrizzleTransactionLocal(this.transactionSourceIdKey, pending);
        runAfterDrizzleCommit(() => {
          this.sourceId ??= pending ?? null;
        });
      }
      return pending;
    });
    return this.storeForSource(sourceId);
  }

  private storeForSource(sourceId: string): DrizzleContextDocumentStore {
    return new DrizzleContextDocumentStore({
      db: this.db,
      contextSourceId: sourceId,
    });
  }

  private async readableSourceStore(): Promise<DrizzleContextDocumentStore | null> {
    const existing = await this.existingContextSourceId();
    return existing ? this.storeForSource(existing) : null;
  }

  async resolveDocumentAt(view: TreeView, path: string) {
    return (
      (await this.readableSourceStore())?.resolveDocumentAt(view, path) ?? {
        kind: "not_found" as const,
      }
    );
  }

  async resolveFolderAt(view: TreeView, path: string) {
    const store = await this.readableSourceStore();
    if (store) return store.resolveFolderAt(view, path);
    // The source root always exists.
    return path.split("/").every((segment) => segment === "")
      ? { kind: "found" as const, node: null }
      : { kind: "not_found" as const };
  }

  /** A document by id is the project's, not this source's: it never waits on the source. */
  findDocumentById(view: TreeView, documentId: string) {
    return locateDocumentById(this.db, view, documentId);
  }

  async listTree(view: TreeView) {
    return (await this.readableSourceStore())?.listTree(view) ?? { folders: [], documents: [] };
  }

  async contextSourceId() {
    return (await this.sourceStore()).contextSourceId();
  }

  async existingContextSourceId(): Promise<string | null> {
    if (this.sourceId) return this.sourceId;
    return runInDrizzleTransaction(this.db, async () => {
      const pendingProvision = getDrizzleTransactionLocal<Promise<string>>(
        this.transactionSourceIdKey,
      );
      if (pendingProvision) return pendingProvision;
      let pending = getDrizzleTransactionLocal<Promise<string | null>>(
        this.transactionExistingSourceIdKey,
      );
      if (!pending) {
        pending = this.findSourceId();
        setDrizzleTransactionLocal(this.transactionExistingSourceIdKey, pending);
        runAfterDrizzleCommit(async () => {
          const sourceId = await pending;
          if (sourceId) this.sourceId ??= Promise.resolve(sourceId);
        });
      }
      return pending;
    });
  }

  async transaction<T>(operation: () => Promise<T>) {
    return runInDrizzleTransaction(this.db, async () => {
      const workId = await this.resolvedWorkId();
      if (workId) await requireLockedActiveWorks(this.db, [workId]);
      await this.beforeWrite?.();
      await this.sourceStore();
      return operation();
    });
  }

  async namesAt(view: TreeView, parentId: string | null) {
    return (await this.readableSourceStore())?.namesAt(view, parentId) ?? new Set<string>();
  }

  async listFolders(view: TreeView, parentId: string | null) {
    return (await this.readableSourceStore())?.listFolders(view, parentId) ?? [];
  }

  async listDocuments(view: TreeView, folderId: string | null) {
    return (await this.readableSourceStore())?.listDocuments(view, folderId) ?? [];
  }
}

export function createProjectContextDocumentStore(
  db: Database,
  projectId: string,
  scheme: ProjectContextFsScheme,
  userId: string,
): ContextDocumentStore {
  const find = () => findProjectContextSource(db, projectId, scheme, userId);
  return new SourceResolvedContextDocumentStore(db, required(find, `${scheme}://`), find);
}

export function createWorkContextDocumentStore(
  db: Database,
  workId: string,
  scheme: WorkScopedContextFsScheme,
): ContextDocumentStore {
  const find = () => findWorkContextSource(db, workId, scheme);
  return new SourceResolvedContextDocumentStore(db, required(find, `${scheme}://`), find, workId);
}

/** Reads never provision lineage notes; the first AI write does. */
export function createLineageContextDocumentStore(
  db: Database,
  projectId: string,
  rootThreadId: string,
  hints: SourceHints,
): ContextDocumentStore {
  const lifecycle = createDrizzleLineageScratchLifecycle(db, undefined, undefined, hints);
  const find = async () => {
    const [row] = await currentDrizzleDb(db)
      .select({ id: contextSources.id })
      .from(contextSources)
      .where(
        and(
          eq(contextSources.projectId, projectId),
          eq(contextSources.rootThreadId, rootThreadId),
          eq(contextSources.slug, "scratch"),
          isNull(contextSources.deletedAt),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  };
  return new SourceResolvedContextDocumentStore(
    db,
    () => lifecycle.ensureSource(projectId, rootThreadId),
    find,
    undefined,
    () => lifecycle.requireLive(projectId, rootThreadId),
  );
}

async function findChatContextSource(
  db: Database,
  projectId: string,
  chatId: string,
  scheme: "uploads",
): Promise<string | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(
      and(
        eq(contextSources.projectId, projectId),
        eq(contextSources.chatThreadId, chatId),
        eq(contextSources.slug, scheme),
        isNull(contextSources.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function ensureChatContextSource(
  db: Database,
  projectId: string,
  chatId: string,
  scheme: "uploads",
  hints: SourceHints,
): Promise<string> {
  const existing = await findChatContextSource(db, projectId, chatId, scheme);
  if (existing) return existing;
  const [created] = await currentDrizzleDb(db)
    .insert(contextSources)
    .values({
      projectId: projectId as ProjectId,
      chatThreadId: chatId as ThreadId,
      name: CONTEXT_SOURCE_NAMES[scheme],
      slug: scheme,
      scope: "chat",
    })
    .onConflictDoNothing({
      target: [contextSources.chatThreadId, contextSources.slug],
      where: sql`${contextSources.chatThreadId} IS NOT NULL`,
    })
    .returning({ id: contextSources.id });
  if (created) {
    hints.publishSourcesHint(projectId);
    return created.id;
  }
  const raced = await findChatContextSource(db, projectId, chatId, scheme);
  if (!raced) throw new Error(`Failed to provision ${scheme} context source for chat ${chatId}`);
  return raced;
}

/**
 * A chat's uploads store, keyed by the chat's thread id (no thread-row FK, so the chat may not
 * exist yet). Reads never provision; the first upload does. Which chat to pass is
 * `resolveTopPrimaryChat`'s answer, never `root_thread_id`.
 */
export function createChatContextDocumentStore(
  db: Database,
  projectId: string,
  chatId: string,
  scheme: "uploads",
  hints: SourceHints,
): ContextDocumentStore {
  return new SourceResolvedContextDocumentStore(
    db,
    () => ensureChatContextSource(db, projectId, chatId, scheme, hints),
    () => findChatContextSource(db, projectId, chatId, scheme),
  );
}
