/**
 * Collab facade scope tests: project-scoped manuscript ownership and activity
 * timestamps after A0 re-homed manuscript sources to project scope.
 */

import { Hocuspocus } from "@hocuspocus/server";
import type { DocumentId, ThreadId, UserId } from "@meridian/contracts/runtime";
import {
  contextSources,
  createDb,
  type Database,
  documents,
  projects,
  threadDocuments,
} from "@meridian/database";
import {
  assertLocalDevPostgresOrExplicitAllow,
  DB_TEST_FIXTURE_USER_ID_PRIMARY,
  resolveDbTestFixtureUserId,
} from "@meridian/database/__test-support__/db-fixtures";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleDocumentAccess } from "../../lib/document-access.js";
import { createDrizzleProjectBootstrapRepository } from "../projects/index.js";
import { createDocumentSyncService, type DocumentSyncFacade } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const runDbTests = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

function createBoundFacade(db: Database): DocumentSyncFacade {
  const facade = createDocumentSyncService({ db, documentAccess: createDrizzleDocumentAccess(db) });
  const hocuspocus = new Hocuspocus({
    yDocOptions: { gc: false, gcFilter: () => true },
    debounce: 0,
    maxDebounce: 0,
    onLoadDocument: ({ documentName }) => facade.loadHocuspocusDocument(documentName as DocumentId),
    onStoreDocument: ({ documentName, document }) =>
      facade.storeHocuspocusDocument(documentName as DocumentId, document),
  });
  facade.bindHocuspocus(hocuspocus);
  return facade;
}

describe.skipIf(!runDbTests || !databaseUrl)("collab facade project-scoped scope", () => {
  let db: Database;
  let userId: UserId;
  let projectId: string;
  let sourceId: string;
  let documentId: DocumentId;

  beforeEach(async () => {
    assertLocalDevPostgresOrExplicitAllow(databaseUrl);
    db = createDb(databaseUrl as string);
    userId = (await resolveDbTestFixtureUserId(databaseUrl as string, {
      fixtureUserId: DB_TEST_FIXTURE_USER_ID_PRIMARY,
      suite: "collab-facade-scope",
    })) as UserId;
    projectId = crypto.randomUUID();
    sourceId = crypto.randomUUID();
    documentId = crypto.randomUUID() as DocumentId;

    await db.insert(projects).values({
      id: projectId,
      userId,
      name: "Scope test",
      slug: `scope-${projectId}`,
    });
    await db.insert(contextSources).values({
      id: sourceId,
      projectId,
      slug: "manuscript",
      name: "Manuscript",
    });
    await db.insert(documents).values({
      id: documentId,
      contextSourceId: sourceId,
      name: "chapter",
      extension: "md",
      markdownProjection: "# Chapter\n\nBody and tail",
      fileType: "markdown",
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("allows requireOwnedDocument for project-scoped manuscript docs", async () => {
    const documentAccess = createDrizzleDocumentAccess(db);
    await expect(documentAccess.requireOwnedDocument(documentId, userId)).resolves.toBeUndefined();
  });

  it("updates project lastActivityAt when a project-scoped manuscript doc is written", async () => {
    const facade = createBoundFacade(db);
    const before = await db
      .select({ lastActivityAt: projects.lastActivityAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    await facade.writeDocument({
      documentId,
      markdown: "# Chapter\n\nUpdated body",
      origin: { type: "user", actorUserId: userId },
    });

    const after = await db
      .select({ lastActivityAt: projects.lastActivityAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    expect(after[0]?.lastActivityAt).not.toBeNull();
    if (before[0]?.lastActivityAt && after[0]?.lastActivityAt) {
      expect(after[0].lastActivityAt.getTime()).toBeGreaterThanOrEqual(
        before[0].lastActivityAt.getTime(),
      );
    } else {
      expect(after[0]?.lastActivityAt).toBeInstanceOf(Date);
    }
  });

  it("touches thread_documents.lastTouchedAt for human thread-scoped writes", async () => {
    const bootstrap =
      await createDrizzleProjectBootstrapRepository(db).ensureDefaultBootstrap(userId);
    const facade = createBoundFacade(db);
    const threadId = bootstrap.threadId as ThreadId;

    await facade.writeDocument({
      documentId: bootstrap.documentId as DocumentId,
      markdown: "# Chapter\n\nHuman thread write",
      origin: { type: "user", actorUserId: userId },
      threadId,
    });

    const [row] = await db
      .select({ lastTouchedAt: threadDocuments.lastTouchedAt })
      .from(threadDocuments)
      .where(
        and(
          eq(threadDocuments.threadId, threadId),
          eq(threadDocuments.documentId, bootstrap.documentId),
        ),
      )
      .limit(1);

    expect(row?.lastTouchedAt).toBeInstanceOf(Date);
  });

  it("applies parallel facade edits without clobbering", async () => {
    const facade = createBoundFacade(db);
    await facade.writeDocument({
      documentId,
      markdown: "# Chapter\n\nBody and tail",
      origin: { type: "user", actorUserId: userId },
    });

    await Promise.all([
      facade.editDocument({
        documentId,
        transform: (markdown) => markdown.replace("Body", "Body a"),
        origin: { type: "user", actorUserId: userId },
      }),
      facade.editDocument({
        documentId,
        transform: (markdown) => markdown.replace("tail", "tail b"),
        origin: { type: "user", actorUserId: userId },
      }),
    ]);

    const read = await facade.readAsMarkdown(documentId);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toBe("# Chapter\n\nBody a and tail b\n");
    }
  });
});
