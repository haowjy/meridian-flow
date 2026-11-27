import { randomUUID } from "node:crypto";
import type { ContextSourceId, DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { projects } from "@meridian/database";
import { LIVE, SYSTEM_ACTOR, sourceRoot } from "@meridian/project-tree";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { DocumentCreationAggregate, MarkdownDocumentStore } from "../../collab/index.js";
import { treeListOfSource } from "../../context/adapters/tree-list-facts.js";
import { MANUSCRIPT_URI } from "../../context/manuscript-uri.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { presentSourceId } from "../../context/tree/tree-addresses.js";
import type { ProjectRepository } from "../ports/project-repository.js";
import { lockUserProjects } from "./project-repository/drizzle.js";

class BootstrapDocumentSeedError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : `Failed to seed chapter document: ${String(cause)}`,
      { cause },
    );
  }
}

export type ProjectBootstrapResult = {
  projectId: ProjectId;
  documentId: DocumentId;
  manuscriptSourceId: ContextSourceId;
  uri: typeof MANUSCRIPT_URI;
};

export type ProjectBootstrapRepository = {
  ensureDefaultBootstrapReady(userId: UserId): Promise<boolean>;
  ensureDefaultBootstrap(userId: UserId): Promise<ProjectBootstrapResult | null>;
};

export function createDrizzleProjectBootstrapRepository(deps: {
  db: Database;
  projects: Pick<ProjectRepository, "create">;
  documents: Pick<MarkdownDocumentStore, "seedFromMarkdown" | "bindStatic"> &
    Pick<DocumentCreationAggregate, "createDocumentAtomically">;
  treeLists: TreeListStore;
}): ProjectBootstrapRepository {
  const { db } = deps;
  type BootstrapDb = Pick<Database, "select">;

  async function hasLiveProject(tx: BootstrapDb, userId: UserId): Promise<boolean> {
    const [existing] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.userId, userId), isNull(projects.deletedAt)))
      .limit(1);
    return existing !== undefined;
  }

  async function createChapter(
    tx: BootstrapDb,
    contextSourceId: ContextSourceId,
  ): Promise<DocumentId> {
    async function seedDocument(documentId: DocumentId): Promise<void> {
      try {
        const seeded = await deps.documents.seedFromMarkdown(
          documentId,
          deps.documents.bindStatic("# Chapter 1\n\n"),
          { type: "system" },
        );
        if (!seeded.ok) {
          throw new Error(`Failed to seed chapter document: ${seeded.error.code}`);
        }
      } catch (cause) {
        throw new BootstrapDocumentSeedError(cause);
      }
    }

    const documentId = randomUUID() as DocumentId;
    const created = await deps.documents.createDocumentAtomically({
      persistIdentity: async () => {
        await deps.treeLists.submit({
          lists: [await treeListOfSource(tx as unknown as Database, contextSourceId)],
          make: ([{ writer }]) => {
            writer.create(LIVE, SYSTEM_ACTOR, {
              kind: "document",
              filetype: "markdown",
              name: "Chapter 1",
              parent: sourceRoot(contextSourceId),
              node: documentId,
            });
          },
        });
        return documentId;
      },
      initializeContent: (claimedId) => seedDocument(claimedId),
    });
    if (!created.created) {
      throw new Error("Failed to claim default chapter document path");
    }
    return documentId;
  }

  async function attemptDefaultBootstrap(userId: UserId): Promise<ProjectBootstrapResult | null> {
    return runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db) as BootstrapDb;
      await lockUserProjects(db, userId);
      if (await hasLiveProject(tx, userId)) return null;
      const project = await deps.projects.create({
        userId,
        title: "My Serial",
        description: "You are a helpful writing assistant for long-form fiction.",
      });
      const manuscriptSourceId = await presentSourceId(db, {
        scheme: "manuscript",
        workId: null,
        owner: { kind: "project", projectId: project.id },
      });
      if (!manuscriptSourceId) throw new Error("The new project has no manuscript source");
      const documentId = await createChapter(tx, manuscriptSourceId);
      return {
        projectId: project.id,
        documentId,
        manuscriptSourceId,
        uri: MANUSCRIPT_URI,
      } satisfies ProjectBootstrapResult;
    });
  }

  return {
    async ensureDefaultBootstrapReady(userId) {
      if (await hasLiveProject(db, userId)) return true;
      try {
        await attemptDefaultBootstrap(userId);
        return true;
      } catch (cause) {
        if (!(cause instanceof BootstrapDocumentSeedError)) throw cause;
        return false;
      }
    },
    async ensureDefaultBootstrap(userId) {
      return attemptDefaultBootstrap(userId);
    },
  };
}
