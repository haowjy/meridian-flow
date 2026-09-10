/**
 * Provision and resolve Drizzle-backed context_sources rows, producing
 * lazily-cached ContextDocumentStore instances for unified ContextFS schemes.
 *
 * Key decision: insert-or-get-with-race-fallback provisioning and the
 * promise-cached SourceResolvedContextDocumentStore are one cohesive concern —
 * they own the DB-level context-source lifecycle, separate from adapter assembly.
 */

import type { Database } from "@meridian/database";
import { contextSources, projects } from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  getDrizzleTransactionLocal,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
  setDrizzleTransactionLocal,
} from "../../shared/drizzle-transaction.js";
import { requireLockedActiveWork } from "../../shared/work-lifecycle-lock.js";
import {
  type ContextDocumentMembershipObserver,
  DrizzleContextDocumentStore,
} from "./adapters/context-fs/drizzle-store.js";
import type { ContextCatalogMutationPort } from "./ports/context-catalog.js";
import type {
  ContextDocumentStore,
  CreateBinaryDocumentInput,
  UpsertBinaryDocumentInput,
  UpsertDocumentInput,
} from "./ports/context-document-store.js";
import type { ProjectContextFsScheme, WorkScopedContextFsScheme } from "./ports/context-port.js";

const CONTEXT_SOURCE_NAMES: Record<ProjectContextFsScheme | WorkScopedContextFsScheme, string> = {
  manuscript: "Manuscript",
  kb: "Knowledge Base",
  user: "User Files",
  scratch: "Scratch",
  uploads: "Uploads",
};

async function ensureUserContextProject(db: Database, userId: string): Promise<string> {
  const existing = await findUserContextProject(db, userId);
  if (existing) return existing;

  const id = crypto.randomUUID();
  const [created] = await currentDrizzleDb(db)
    .insert(projects)
    .values({
      id,
      userId,
      name: "User Files",
      slug: `user-files-${id}`,
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

async function findProjectContextSource(
  db: Database,
  projectId: string,
  scheme: ProjectContextFsScheme | WorkScopedContextFsScheme,
  userId: string,
): Promise<string | null> {
  const sourceProjectId = scheme === "user" ? await findUserContextProject(db, userId) : projectId;
  if (!sourceProjectId) return null;
  const [row] = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(
      and(
        eq(contextSources.projectId, sourceProjectId),
        eq(contextSources.slug, scheme),
        isNull(contextSources.workId),
        isNull(contextSources.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function ensureProjectContextSource(
  db: Database,
  projectId: string,
  scheme: ProjectContextFsScheme | WorkScopedContextFsScheme,
  userId: string,
): Promise<string> {
  const sourceProjectId =
    scheme === "user" ? await ensureUserContextProject(db, userId) : projectId;
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
      where: sql`${contextSources.workId} IS NULL AND ${contextSources.deletedAt} IS NULL`,
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
  const [row] = await db
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

async function ensureWorkContextSource(
  db: Database,
  workId: string,
  scheme: WorkScopedContextFsScheme,
): Promise<string> {
  return runInDrizzleTransaction(db, async () => {
    await requireLockedActiveWork(db, workId);
    const activeDb = currentDrizzleDb(db) as Database;
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
    private readonly membershipObserver?: ContextDocumentMembershipObserver,
    private readonly workId?: string,
    private readonly catalogMutations?: ContextCatalogMutationPort,
  ) {}

  private async mutate<T>(operation: (store: DrizzleContextDocumentStore) => Promise<T>) {
    const workId = this.workId;
    return runInDrizzleTransaction(this.db, async () => {
      if (workId) await requireLockedActiveWork(this.db, workId);
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
    return new DrizzleContextDocumentStore({
      db: this.db,
      contextSourceId: sourceId,
      membershipObserver: this.membershipObserver,
      catalogMutations: this.catalogMutations,
    });
  }

  async findFolder(parentId: string | null, name: string) {
    return (await this.sourceStore()).findFolder(parentId, name);
  }

  async createFolder(parentId: string | null, name: string) {
    return this.mutate((store) => store.createFolder(parentId, name));
  }

  async findDocument(folderId: string | null, name: string, extension: string) {
    return (await this.sourceStore()).findDocument(folderId, name, extension);
  }

  async findDocumentById(documentId: string) {
    return (await this.sourceStore()).findDocumentById(documentId);
  }

  async recordDocumentMembership(documentId: string) {
    return this.mutate((store) => store.recordDocumentMembership(documentId));
  }

  async updateDocumentProjection(documentId: string, markdown: string) {
    return this.mutate((store) => store.updateDocumentProjection(documentId, markdown));
  }

  async upsertDocument(input: UpsertDocumentInput) {
    return this.mutate((store) => store.upsertDocument(input));
  }

  async createDocumentRecordIfAbsent(input: UpsertDocumentInput) {
    return this.mutate((store) => store.createDocumentRecordIfAbsent(input));
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput) {
    return this.mutate((store) => store.createBinaryDocument(input));
  }

  async upsertBinaryDocument(input: UpsertBinaryDocumentInput) {
    return this.mutate((store) => store.upsertBinaryDocument(input));
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
    const workId = this.workId;
    return runInDrizzleTransaction(this.db, async () => {
      if (workId) await requireLockedActiveWork(this.db, workId);
      await this.sourceStore();
      return operation();
    });
  }

  async listFolders(parentId: string | null) {
    return (await this.sourceStore()).listFolders(parentId);
  }

  async listDocuments(folderId: string | null) {
    return (await this.sourceStore()).listDocuments(folderId);
  }
}

export function createProjectContextDocumentStore(
  db: Database,
  projectId: string,
  scheme: ProjectContextFsScheme | WorkScopedContextFsScheme,
  userId: string,
  membershipObserver?: ContextDocumentMembershipObserver,
  catalogMutations?: ContextCatalogMutationPort,
): ContextDocumentStore {
  return new SourceResolvedContextDocumentStore(
    db,
    () => ensureProjectContextSource(db, projectId, scheme, userId),
    () => findProjectContextSource(db, projectId, scheme, userId),
    membershipObserver,
    undefined,
    catalogMutations,
  );
}

export function createWorkContextDocumentStore(
  db: Database,
  workId: string,
  scheme: WorkScopedContextFsScheme,
  membershipObserver?: ContextDocumentMembershipObserver,
  catalogMutations?: ContextCatalogMutationPort,
): ContextDocumentStore {
  return new SourceResolvedContextDocumentStore(
    db,
    () => ensureWorkContextSource(db, workId, scheme),
    () => findWorkContextSource(db, workId, scheme),
    membershipObserver,
    workId,
    catalogMutations,
  );
}
