/**
 * Collab facade scope tests: project-scoped manuscript ownership and activity
 * timestamps after A0 re-homed manuscript sources to project scope.
 */
import type { DocumentId, ThreadId, UserId } from "@meridian/contracts/runtime";
import {
  contextSources,
  createDb,
  type Database,
  documents,
  projects,
  threadDocuments,
} from "@meridian/database";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleProjectBootstrapRepository } from "../projects/index.js";
import { createDocumentSyncService } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const testUserId = process.env.TEST_USER_ID;
const testUserEmail = process.env.TEST_USER_EMAIL ?? "test@meridian.dev";
const fallbackTestUserId = "00000000-0000-4000-8000-000000000111" as UserId;

function assertSafeTestDatabase(): void {
  if (!databaseUrl || process.env.TEST_DB_ALLOW_DESTRUCTIVE === "1") return;
  if (!databaseUrl.includes("127.0.0.1:54422")) {
    throw new Error(
      "Refusing collab facade scope tests: DATABASE_URL must be local Supabase (127.0.0.1:54422)",
    );
  }
}

async function resolveTestUserId(): Promise<UserId> {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    if (testUserId) {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO auth.users (
          id, email, aud, role, raw_app_meta_data, raw_user_meta_data,
          email_confirmed_at, created_at, updated_at
        )
        VALUES (
          ${testUserId}::uuid, ${testUserEmail}, 'authenticated', 'authenticated',
          '{}'::jsonb, '{}'::jsonb, now(), now(), now()
        )
        ON CONFLICT (id) DO UPDATE
        SET email = excluded.email, updated_at = now()
        RETURNING id::text
      `;
      return rows[0]?.id as UserId;
    }

    const rows = await sql<{ id: string }[]>`
      SELECT id::text
      FROM auth.users
      WHERE email = ${testUserEmail}
      LIMIT 1
    `;
    if (rows[0]?.id) return rows[0].id as UserId;

    const inserted = await sql<{ id: string }[]>`
      INSERT INTO auth.users (
        id, email, aud, role, raw_app_meta_data, raw_user_meta_data,
        email_confirmed_at, created_at, updated_at
      )
      VALUES (
        ${fallbackTestUserId}::uuid, ${testUserEmail}, 'authenticated', 'authenticated',
        '{}'::jsonb, '{}'::jsonb, now(), now(), now()
      )
      ON CONFLICT (id) DO UPDATE
      SET email = excluded.email, updated_at = now()
      RETURNING id::text
    `;
    return inserted[0]?.id as UserId;
  } finally {
    await sql.end();
  }
}

describe.skipIf(!databaseUrl)("collab facade project-scoped scope", () => {
  let db: Database;
  let userId: UserId;
  let projectId: string;
  let sourceId: string;
  let documentId: DocumentId;

  beforeEach(async () => {
    assertSafeTestDatabase();
    db = createDb(databaseUrl as string);
    userId = await resolveTestUserId();
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
      markdownProjection: "# Chapter",
      fileType: "markdown",
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("allows requireOwnedDocument for project-scoped manuscript docs", async () => {
    const facade = createDocumentSyncService({ db });
    await expect(facade.requireOwnedDocument(documentId, userId)).resolves.toBeUndefined();
  });

  it("updates project lastActivityAt when a project-scoped manuscript doc is written", async () => {
    const facade = createDocumentSyncService({ db });
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
    const facade = createDocumentSyncService({ db });
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
    const facade = createDocumentSyncService({ db });
    await facade.initializeMirror(documentId);

    await Promise.all([
      facade.editDocument({
        documentId,
        transform: (markdown) => `${markdown}a`,
        origin: { type: "user", actorUserId: userId },
      }),
      facade.editDocument({
        documentId,
        transform: (markdown) => `${markdown}b`,
        origin: { type: "user", actorUserId: userId },
      }),
    ]);

    const read = await facade.readAsMarkdown(documentId);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toMatch(/^# Chapter(ab|ba)$/);
    }
  });
});
