import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import postgres from "postgres";

export type Db = ReturnType<typeof postgres>;

export function openE2eDb(databaseUrl: string): Db {
  return postgres(databaseUrl, { max: 1 });
}

export async function login(page: Page): Promise<void> {
  await page.goto("/api/auth/dev-login", { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/"), { timeout: 30_000 });
}

export async function findInternalUserId(db: Db, externalUserId: string): Promise<string> {
  const rows = await db<{ id: string }[]>`
    SELECT id::text AS id FROM users WHERE external_id = ${externalUserId} LIMIT 1
  `;
  const row = rows[0];
  if (!row?.id) {
    throw new Error(`No provisioned user row found for WORKOS_DEV_LOGIN_USER_ID=${externalUserId}`);
  }
  return row.id;
}

/** Idempotent e2e fixture user — does not depend on bootstrap or auth.setup ordering. */
export async function ensureTestUserId(db: Db): Promise<string> {
  const externalUserId = process.env.WORKOS_DEV_LOGIN_USER_ID?.trim();
  if (!externalUserId) {
    throw new Error("WORKOS_DEV_LOGIN_USER_ID is required for e2e user lookup");
  }
  const email = process.env.WORKOS_DEV_LOGIN_EMAIL?.trim() || "test@meridian.dev";
  const rows = await db<{ id: string }[]>`
    INSERT INTO public.users (external_id, email, created_at, updated_at)
    VALUES (${externalUserId}, ${email}, now(), now())
    ON CONFLICT (external_id) DO UPDATE
    SET email = EXCLUDED.email, updated_at = now()
    RETURNING id::text
  `;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(`Failed to ensure user row for WORKOS_DEV_LOGIN_USER_ID=${externalUserId}`);
  }
  return id;
}

export async function findTestUserId(db: Db): Promise<string> {
  return ensureTestUserId(db);
}

export type ProjectFixture = {
  projectId: string;
  workId: string;
  threadId: string;
  contextSourceId: string;
  documentIds: string[];
  title: string;
};

export async function seedProjectFixture(
  db: Db,
  request: APIRequestContext,
  input: { userId: string; titlePrefix: string },
): Promise<ProjectFixture> {
  const projectId = randomUUID();
  const workId = randomUUID();
  const threadId = randomUUID();
  const contextSourceId = randomUUID();
  const title = `${input.titlePrefix} ${projectId.slice(0, 8)}`;

  await db.begin(async (tx) => {
    await tx`
      INSERT INTO projects (id, user_id, name, slug, is_personal)
      VALUES (${projectId}, ${input.userId}, ${title}, ${`e2e-${projectId}`}, false)
    `;
    await tx`
      INSERT INTO works (id, project_id, created_by_user_id, name, slug)
      VALUES (${workId}, ${projectId}, ${input.userId}, 'Main Arc', 'main-arc')
    `;
    await tx`
      INSERT INTO threads (id, project_id, created_by_user_id, title, kind, status)
      VALUES (${threadId}, ${projectId}, ${input.userId}, ${title}, 'primary', 'active')
    `;
    await tx`
      INSERT INTO thread_works (thread_id, work_id, project_id, is_primary)
      VALUES (${threadId}, ${workId}, ${projectId}, true)
    `;
    await tx`
      INSERT INTO context_sources (id, project_id, name, slug, scope, adapter_type, is_primary, sort_order)
      VALUES (${contextSourceId}, ${projectId}, 'Knowledge Base', 'kb', 'project', 'local', false, 1)
    `;
  });

  try {
    const alphaId = await createFixtureDocument(request, projectId, {
      path: "/alpha.md",
      content: "# Alpha\n\nSeed context.",
    });
    const betaId = await createFixtureDocument(request, projectId, {
      path: "/beta.md",
      content: "# Beta\n\nSeed context.",
    });

    return {
      projectId,
      workId,
      threadId,
      contextSourceId,
      documentIds: [alphaId, betaId],
      title,
    };
  } catch (error) {
    await cleanupProjectFixture(db, {
      projectId,
      workId,
      threadId,
      contextSourceId,
      documentIds: [],
      title,
    });
    throw error;
  }
}

async function createFixtureDocument(
  request: APIRequestContext,
  projectId: string,
  input: { path: string; content: string },
): Promise<string> {
  const response = await request.post(`/api/projects/${projectId}/context/kb/create`, {
    data: { type: "file", ...input },
  });
  if (!response.ok()) {
    throw new Error(
      `Failed to create fixture document ${input.path}: ${response.status()} ${await response.text()}`,
    );
  }

  const body: unknown = await response.json();
  const documentId =
    body && typeof body === "object" && "documentId" in body ? body.documentId : undefined;
  if (typeof documentId !== "string") {
    throw new Error(`Fixture document ${input.path} response did not include a document ID`);
  }
  return documentId;
}

export async function cleanupProjectFixture(db: Db, fixture: ProjectFixture): Promise<void> {
  await db.begin(async (tx) => {
    await tx`
      DELETE FROM turn_blocks
      WHERE turn_id IN (SELECT id FROM turns WHERE thread_id = ${fixture.threadId})
    `;
    await tx`DELETE FROM event_journal WHERE thread_id = ${fixture.threadId}`;
    await tx`DELETE FROM thread_documents WHERE thread_id = ${fixture.threadId}`;
    await tx`DELETE FROM turn_document_touches WHERE thread_id = ${fixture.threadId}`;
    await tx`DELETE FROM turns WHERE thread_id = ${fixture.threadId}`;
    await tx`DELETE FROM threads WHERE id = ${fixture.threadId}`;
    await tx`
      DELETE FROM context_sources
      WHERE project_id = ${fixture.projectId}
      OR work_id IN (SELECT id FROM works WHERE project_id = ${fixture.projectId})
    `;
    await tx`DELETE FROM works WHERE project_id = ${fixture.projectId}`;
    await tx`DELETE FROM projects WHERE id = ${fixture.projectId}`;
  });
}

export async function resetUserProjects(db: Db, userId: string): Promise<void> {
  await db.begin(async (tx) => {
    await tx`
      DELETE FROM event_journal
      WHERE thread_id IN (
        SELECT id FROM threads WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${userId}::uuid)
      )
      OR turn_id IN (
        SELECT id FROM turns
        WHERE thread_id IN (
          SELECT id FROM threads WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${userId}::uuid)
        )
      )
    `;
    await tx`
      DELETE FROM project_results
      WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${userId}::uuid)
      OR thread_id IN (
        SELECT id FROM threads WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${userId}::uuid)
      )
      OR root_thread_id IN (
        SELECT id FROM threads WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${userId}::uuid)
      )
      OR turn_id IN (
        SELECT id FROM turns
        WHERE thread_id IN (
          SELECT id FROM threads WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${userId}::uuid)
        )
      )
    `;
    await tx`
      UPDATE threads
      SET
        parent_thread_id = NULL,
        origin_turn_id = NULL,
        origin_type = NULL,
        spawn_status = NULL,
        active_leaf_turn_id = NULL
      WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${userId}::uuid)
    `;
    await tx`
      DELETE FROM turns
      WHERE thread_id IN (
        SELECT id FROM threads WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${userId}::uuid)
      )
    `;
    await tx`
      DELETE FROM context_sources
      WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${userId}::uuid)
      OR work_id IN (
        SELECT id FROM works WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${userId}::uuid)
      )
    `;
    await tx`DELETE FROM projects WHERE user_id = ${userId}::uuid`;
  });
}

/**
 * Clear the dev-login user's projects so the next authenticated request provisions
 * a fresh personal project via ensureDefaultBootstrap.
 */
export async function prepareAuthenticatedProjectAccess(db: Db): Promise<void> {
  const userId = await ensureTestUserId(db);
  await resetUserProjects(db, userId);
}
