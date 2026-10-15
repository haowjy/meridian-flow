/**
 * Provision and resolve Drizzle-backed context_sources rows, producing
 * lazily-cached ContextDocumentStore instances for unified ContextFS schemes.
 *
 * Key decision: insert-or-get-with-race-fallback provisioning and the
 * promise-cached SourceResolvedContextDocumentStore are one cohesive concern —
 * they own the DB-level context-source lifecycle, separate from adapter assembly.
 */

import type { DocumentId, ProjectId, ThreadId } from "@meridian/contracts";
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
import { nextProjectSlug } from "../projects/adapters/project-repository/shared.js";
import { lockContextSources } from "./adapters/context-fs/document-locations.js";
import { DrizzleContextDocumentStore } from "./adapters/context-fs/drizzle-store.js";
import { createDrizzleLineageScratchLifecycle } from "./adapters/lineage-scratch-lifecycle.js";
import type { ContextCatalogMutationPort } from "./ports/context-catalog.js";
import type {
  ContextDocumentStore,
  CreateBinaryDocumentInput,
  CreateDocumentInput,
} from "./ports/context-document-store.js";
import type { ProjectContextFsScheme, WorkScopedContextFsScheme } from "./ports/context-port.js";
import type { DocumentArrivals } from "./ports/document-arrivals.js";
import { findForward, recordForward } from "./tree/forwards.js";
import type { HiddenNodeRepair } from "./tree/hidden-node-repair.js";
import type { LiveClaim } from "./tree/hidden-node-types.js";
import type { TreeView } from "./tree/tree-view.js";

const CONTEXT_SOURCE_NAMES: Record<ProjectContextFsScheme | WorkScopedContextFsScheme, string> = {
  manuscript: "Manuscript",
  kb: "Knowledge Base",
  user: "User Files",
  unfiled: "Unfiled",
  scratch: "Scratch",
  uploads: "Uploads",
};

async function ensureUserContextProject(db: Database, userId: string): Promise<string> {
  await currentDrizzleDb(db).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0::bigint))`,
  );
  const existing = await findUserContextProject(db, userId);
  if (existing) return existing;

  const reserved = await currentDrizzleDb(db)
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.userId, userId));
  const id = crypto.randomUUID();
  const [created] = await currentDrizzleDb(db)
    .insert(projects)
    .values({
      id,
      userId,
      name: "User Files",
      slug: nextProjectSlug(
        "User Files",
        reserved.map((row) => row.slug),
      ),
      isPersonal: true,
    })
    .returning({ id: projects.id });
  if (!created) throw new Error(`Failed to provision user context project for ${userId}`);
  return created.id;
}

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

async function ensureProjectContextSource(
  db: Database,
  projectId: string,
  scheme: ProjectContextFsScheme,
  userId: string,
): Promise<string> {
  const sourceProjectId = storedInPersonalProject(scheme)
    ? await ensureUserContextProject(db, userId)
    : projectId;
  const existing = await findProjectContextSource(db, projectId, scheme, userId);
  if (existing) return existing;

  const [created] = await currentDrizzleDb(db)
    .insert(contextSources)
    .values({
      projectId: sourceProjectId,
      name: CONTEXT_SOURCE_NAMES[scheme],
      slug: scheme,
      scope: "project",
      adapterType: "local",
    })
    .onConflictDoNothing({
      target: [contextSources.projectId, contextSources.slug],
      where: sql`${contextSources.workId} IS NULL AND ${contextSources.rootThreadId} IS NULL AND ${contextSources.chatThreadId} IS NULL AND ${contextSources.deletedAt} IS NULL`,
    })
    .returning({ id: contextSources.id });
  if (created) return created.id;

  const raced = await findProjectContextSource(db, projectId, scheme, userId);
  if (!raced) throw new Error(`Failed to provision ${scheme} context source for ${projectId}`);
  return raced;
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

export async function ensureWorkContextSource(
  db: Database,
  workId: string,
  scheme: WorkScopedContextFsScheme,
): Promise<string> {
  return runInDrizzleTransaction(db, async () => {
    await requireLockedActiveWorks(db, [workId]);
    const activeDb = currentDrizzleDb(db) as Database;
    if (scheme === "scratch") {
      const [work] = await activeDb
        .select({ isNoWork: works.isNoWork })
        .from(works)
        .where(eq(works.id, workId));
      if (work?.isNoWork) throw new Error("No Work does not own Scratch");
    }
    const existing = await findWorkContextSource(activeDb, workId, scheme);
    if (existing) return existing;

    const [created] = await activeDb
      .insert(contextSources)
      .values({
        workId,
        name: CONTEXT_SOURCE_NAMES[scheme],
        slug: scheme,
        scope: "work",
        adapterType: "local",
      })
      .onConflictDoNothing({
        target: [contextSources.workId, contextSources.slug],
        where: sql`${contextSources.workId} IS NOT NULL AND ${contextSources.deletedAt} IS NULL`,
      })
      .returning({ id: contextSources.id });
    if (created) return created.id;

    const raced = await findWorkContextSource(activeDb, workId, scheme);
    if (!raced) throw new Error(`Failed to provision ${scheme} context source for Work ${workId}`);
    return raced;
  });
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
    private readonly catalogMutations?: ContextCatalogMutationPort,
    private readonly beforeWrite?: () => Promise<void>,
    private readonly arrivals?: DocumentArrivals,
    private readonly repair?: HiddenNodeRepair,
  ) {}

  private async resolvedWorkId(): Promise<string | undefined> {
    return typeof this.workId === "function" ? this.workId() : this.workId;
  }

  private async mutate<T>(operation: (store: DrizzleContextDocumentStore) => Promise<T>) {
    return runInDrizzleTransaction(this.db, async () => {
      const workId = await this.resolvedWorkId();
      if (workId) await requireLockedActiveWorks(this.db, [workId]);
      await this.beforeWrite?.();
      return operation(await this.sourceStore());
    });
  }

  private async sourceStore(): Promise<DrizzleContextDocumentStore> {
    const sourceId = await runInDrizzleTransaction(this.db, async () => {
      if (this.sourceId) return this.sourceId;
      let pending = getDrizzleTransactionLocal<Promise<string>>(this.transactionSourceIdKey);
      if (!pending) {
        pending = (async () => {
          const resolved = await this.ensureSourceId();
          await lockContextSources(this.db, [resolved]);
          await this.catalogMutations?.refreshSources([resolved]);
          return resolved;
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
      catalogMutations: this.catalogMutations,
      arrivals: this.arrivals,
      ...(this.repair ? { repair: this.repair } : {}),
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

  async findDocument(folderId: string | null, name: string, extension: string) {
    return (await this.readableSourceStore())?.findDocument(folderId, name, extension) ?? null;
  }

  async findDocumentById(view: TreeView, documentId: string) {
    return (await this.readableSourceStore())?.findDocumentById(view, documentId) ?? null;
  }

  /** A forward is the project's, not this source's: it never waits on the source. */
  findForward(fromId: string, projectId: ProjectId) {
    return findForward(this.db, fromId, projectId);
  }

  async listHiddenNames(folderId: string | null) {
    return (await this.readableSourceStore())?.listHiddenNames(folderId) ?? [];
  }

  async findDocumentLastLocation(documentId: string) {
    return (await this.readableSourceStore())?.findDocumentLastLocation(documentId) ?? null;
  }

  async readProjections(ids: string[]): Promise<Map<string, string>> {
    const store = await this.readableSourceStore();
    return store ? store.readProjections(ids) : new Map();
  }

  async ensureFolderPath(dir: readonly string[]) {
    // The source root always exists.
    if (dir.length === 0) return null;
    return this.mutate((store) => store.ensureFolderPath(dir));
  }

  async findLiveCreateCandidate(dir: readonly string[], name: string, extension: string) {
    return (
      (await this.readableSourceStore())?.findLiveCreateCandidate(dir, name, extension) ?? {
        kind: "none" as const,
      }
    );
  }

  async createDocumentRecordIfAbsent(input: CreateDocumentInput, claim?: LiveClaim) {
    return this.mutate((store) => store.createDocumentRecordIfAbsent(input, claim));
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput) {
    return this.mutate((store) => store.createBinaryDocument(input));
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
  catalogMutations?: ContextCatalogMutationPort,
  arrivals?: DocumentArrivals,
  repair?: HiddenNodeRepair,
): ContextDocumentStore {
  return new SourceResolvedContextDocumentStore(
    db,
    () => ensureProjectContextSource(db, projectId, scheme, userId),
    () => findProjectContextSource(db, projectId, scheme, userId),
    undefined,
    catalogMutations,
    undefined,
    arrivals,
    repair,
  );
}

export function createWorkContextDocumentStore(
  db: Database,
  workId: string,
  scheme: WorkScopedContextFsScheme,
  catalogMutations?: ContextCatalogMutationPort,
  arrivals?: DocumentArrivals,
  repair?: HiddenNodeRepair,
): ContextDocumentStore {
  return new SourceResolvedContextDocumentStore(
    db,
    () => ensureWorkContextSource(db, workId, scheme),
    () => findWorkContextSource(db, workId, scheme),
    workId,
    catalogMutations,
    undefined,
    arrivals,
    repair,
  );
}

export function createNoWorkContextDocumentStore(
  db: Database,
  projectId: string,
  scheme: "uploads",
  catalogMutations?: ContextCatalogMutationPort,
  arrivals?: DocumentArrivals,
  repair?: HiddenNodeRepair,
): ContextDocumentStore {
  const resolveWorkId = async () => {
    const workId = await findNoWorkId(db, projectId);
    if (!workId) throw new Error(`No Work missing for project ${projectId}`);
    return workId;
  };
  return new SourceResolvedContextDocumentStore(
    db,
    async () => ensureWorkContextSource(db, await resolveWorkId(), scheme),
    async () => {
      const workId = await findNoWorkId(db, projectId);
      return workId ? findWorkContextSource(db, workId, scheme) : null;
    },
    resolveWorkId,
    catalogMutations,
    undefined,
    arrivals,
    repair,
  );
}

/** Reads never provision lineage notes; the first AI write does. */
export function createLineageContextDocumentStore(
  db: Database,
  projectId: string,
  rootThreadId: string,
  catalogMutations?: ContextCatalogMutationPort,
  arrivals?: DocumentArrivals,
  repair?: HiddenNodeRepair,
): ContextDocumentStore {
  const lifecycle = createDrizzleLineageScratchLifecycle(db, catalogMutations, arrivals);
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
    catalogMutations,
    () => lifecycle.requireLive(projectId, rootThreadId),
    arrivals,
    repair,
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
      adapterType: "local",
    })
    .onConflictDoNothing({
      target: [contextSources.chatThreadId, contextSources.slug],
      where: sql`${contextSources.chatThreadId} IS NOT NULL`,
    })
    .returning({ id: contextSources.id });
  if (created) return created.id;
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
  catalogMutations?: ContextCatalogMutationPort,
  arrivals?: DocumentArrivals,
  repair?: HiddenNodeRepair,
): ContextDocumentStore {
  return new SourceResolvedContextDocumentStore(
    db,
    () => ensureChatContextSource(db, projectId, chatId, scheme),
    () => findChatContextSource(db, projectId, chatId, scheme),
    undefined,
    catalogMutations,
    undefined,
    arrivals,
    repair,
  );
}
