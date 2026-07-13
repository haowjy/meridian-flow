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
  type ContextDocumentMembershipObserver,
  DrizzleContextDocumentStore,
} from "./adapters/context-fs/drizzle-store.js";
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
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.userId, userId), eq(projects.isPersonal, true), isNull(projects.deletedAt)),
    )
    .limit(1);
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  const [created] = await db
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

async function findProjectContextSource(
  db: Database,
  projectId: string,
  scheme: ProjectContextFsScheme,
  userId: string,
): Promise<string | null> {
  const sourceProjectId =
    scheme === "user" ? await ensureUserContextProject(db, userId) : projectId;
  const [row] = await db
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
  scheme: ProjectContextFsScheme,
  userId: string,
): Promise<string> {
  const sourceProjectId =
    scheme === "user" ? await ensureUserContextProject(db, userId) : projectId;
  const existing = await findProjectContextSource(db, projectId, scheme, userId);
  if (existing) return existing;

  const [created] = await db
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
  const existing = await findWorkContextSource(db, workId, scheme);
  if (existing) return existing;

  const [created] = await db
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

  const raced = await findWorkContextSource(db, workId, scheme);
  if (!raced) throw new Error(`Failed to provision ${scheme} context source for Work ${workId}`);
  return raced;
}

class SourceResolvedContextDocumentStore implements ContextDocumentStore {
  private sourceId: Promise<string> | null = null;

  constructor(
    private readonly db: Database,
    private readonly resolveSourceId: () => Promise<string>,
    private readonly membershipObserver?: ContextDocumentMembershipObserver,
  ) {}

  private async sourceStore(): Promise<DrizzleContextDocumentStore> {
    this.sourceId ??= this.resolveSourceId();
    return new DrizzleContextDocumentStore({
      db: this.db,
      contextSourceId: await this.sourceId,
      membershipObserver: this.membershipObserver,
    });
  }

  async findFolder(parentId: string | null, name: string) {
    return (await this.sourceStore()).findFolder(parentId, name);
  }

  async createFolder(parentId: string | null, name: string) {
    return (await this.sourceStore()).createFolder(parentId, name);
  }

  async findDocument(folderId: string | null, name: string, extension: string) {
    return (await this.sourceStore()).findDocument(folderId, name, extension);
  }

  async updateDocumentProjection(documentId: string, markdown: string) {
    return (await this.sourceStore()).updateDocumentProjection(documentId, markdown);
  }

  async upsertDocument(input: UpsertDocumentInput) {
    return (await this.sourceStore()).upsertDocument(input);
  }

  async createDocumentIfAbsent(input: UpsertDocumentInput) {
    return (await this.sourceStore()).createDocumentIfAbsent(input);
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput) {
    return (await this.sourceStore()).createBinaryDocument(input);
  }

  async upsertBinaryDocument(input: UpsertBinaryDocumentInput) {
    return (await this.sourceStore()).upsertBinaryDocument(input);
  }

  async contextSourceId() {
    return (await this.sourceStore()).contextSourceId();
  }

  async transaction<T>(operation: () => Promise<T>) {
    return (await this.sourceStore()).transaction(operation);
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
  scheme: ProjectContextFsScheme,
  userId: string,
  membershipObserver?: ContextDocumentMembershipObserver,
): ContextDocumentStore {
  return new SourceResolvedContextDocumentStore(
    db,
    () => ensureProjectContextSource(db, projectId, scheme, userId),
    membershipObserver,
  );
}

export function createWorkContextDocumentStore(
  db: Database,
  workId: string,
  scheme: WorkScopedContextFsScheme,
): ContextDocumentStore {
  return new SourceResolvedContextDocumentStore(db, () =>
    ensureWorkContextSource(db, workId, scheme),
  );
}
