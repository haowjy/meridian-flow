/** Project context-port factory: builds per-project ContextFS routers without external execution providers. */
import type { Database } from "@meridian/database";
import { contextSources, projects } from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createInMemoryDocumentStore } from "../collab/adapters/in-memory/index.js";
import { createDocumentSyncService } from "../collab/domain/document-sync-service.js";
import type { DocumentSyncPort } from "../collab/ports/document-sync.js";
import { ContextFS } from "./adapters/context-fs/context-fs.js";
import { DrizzleContextDocumentStore } from "./adapters/context-fs/drizzle-store.js";
import { InMemoryContextDocumentStore } from "./adapters/context-fs/in-memory-store.js";
import { createContextPortRouter } from "./context/router.js";
import type { ContextSchemeAdapter } from "./ports/context-adapter.js";
import type {
  ContextDocumentStore,
  CreateBinaryDocumentInput,
  UpsertDocumentInput,
} from "./ports/context-document-store.js";
import type { ContextPort, ContextScheme } from "./ports/context-port.js";

const CONTEXT_SCHEMES = ["kb", "work", "user", "fs1"] as const satisfies readonly ContextScheme[];

const CONTEXT_SOURCE_NAMES: Record<ContextScheme, string> = {
  kb: "Knowledge Base",
  work: "Work Memory",
  user: "User Files",
  fs1: "Project Files",
};

export interface ProjectContextPortFactory {
  forProject(projectId: string, userId: string): ContextPort;
}

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
  scheme: ContextScheme,
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
  scheme: ContextScheme,
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

class ProjectContextDocumentStore implements ContextDocumentStore {
  private sourceId: Promise<string> | null = null;

  constructor(
    private readonly db: Database,
    private readonly projectId: string,
    private readonly scheme: ContextScheme,
    private readonly userId: string,
  ) {}

  private async sourceStore(): Promise<DrizzleContextDocumentStore> {
    this.sourceId ??= ensureProjectContextSource(this.db, this.projectId, this.scheme, this.userId);
    return new DrizzleContextDocumentStore({ db: this.db, contextSourceId: await this.sourceId });
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
  async upsertDocument(input: UpsertDocumentInput) {
    return (await this.sourceStore()).upsertDocument(input);
  }
  async createBinaryDocument(input: CreateBinaryDocumentInput) {
    return (await this.sourceStore()).createBinaryDocument(input);
  }
  async listFolders(parentId: string | null) {
    return (await this.sourceStore()).listFolders(parentId);
  }
  async listDocuments(folderId: string | null) {
    return (await this.sourceStore()).listDocuments(folderId);
  }
  async searchDocuments(query: string) {
    return (await this.sourceStore()).searchDocuments(query);
  }
}

function buildPort(
  storeFor: (scheme: ContextScheme) => ContextDocumentStore,
  documentSync: DocumentSyncPort,
): ContextPort {
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of CONTEXT_SCHEMES) {
    adapters.set(scheme, new ContextFS({ store: storeFor(scheme), documentSync, scheme }));
  }
  return createContextPortRouter({ adapters });
}

function cacheKey(projectId: string, userId: string): string {
  return `${userId}:${projectId}`;
}

export function createInMemoryProjectContextPortFactory(
  options: { documentSync?: DocumentSyncPort } = {},
): ProjectContextPortFactory {
  const documentSync =
    options.documentSync ?? createDocumentSyncService(createInMemoryDocumentStore());
  const entries = new Map<string, ContextPort>();
  return {
    forProject(projectId, userId) {
      const key = cacheKey(projectId, userId);
      let port = entries.get(key);
      if (!port) {
        port = buildPort(() => new InMemoryContextDocumentStore(), documentSync);
        entries.set(key, port);
      }
      return port;
    },
  };
}

export function createProductionProjectContextPortFactory(options: {
  db: Database;
  documentSync: DocumentSyncPort;
}): ProjectContextPortFactory {
  const entries = new Map<string, ContextPort>();
  return {
    forProject(projectId, userId) {
      const key = cacheKey(projectId, userId);
      let port = entries.get(key);
      if (!port) {
        port = buildPort(
          (scheme) => new ProjectContextDocumentStore(options.db, projectId, scheme, userId),
          options.documentSync,
        );
        entries.set(key, port);
      }
      return port;
    },
  };
}
