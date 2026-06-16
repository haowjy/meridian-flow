import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
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

export async function findTestUserId(db: Db): Promise<string> {
  const externalUserId = process.env.WORKOS_DEV_LOGIN_USER_ID?.trim();
  if (!externalUserId) {
    throw new Error("WORKOS_DEV_LOGIN_USER_ID is required for e2e user lookup");
  }
  return findInternalUserId(db, externalUserId);
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
  input: { userId: string; titlePrefix: string },
): Promise<ProjectFixture> {
  const projectId = randomUUID();
  const workId = randomUUID();
  const threadId = randomUUID();
  const contextSourceId = randomUUID();
  const alphaId = randomUUID();
  const betaId = randomUUID();
  const title = `${input.titlePrefix} ${projectId.slice(0, 8)}`;

  await db.begin(async (tx) => {
    await tx`
      INSERT INTO projects (id, user_id, name, slug, is_personal)
      VALUES (${projectId}, ${input.userId}, ${title}, ${`e2e-${projectId}`}, false)
    `;
    await tx`
      INSERT INTO works (id, project_id, created_by_user_id, title)
      VALUES (${workId}, ${projectId}, ${input.userId}, 'Main Arc')
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
    await tx`
      INSERT INTO documents (id, context_source_id, name, extension, file_type, markdown_projection)
      VALUES
        (${alphaId}, ${contextSourceId}, 'alpha', 'md', 'markdown', '# Alpha\n\nSeed context.'),
        (${betaId}, ${contextSourceId}, 'beta', 'md', 'markdown', '# Beta\n\nSeed context.')
    `;
  });

  return {
    projectId,
    workId,
    threadId,
    contextSourceId,
    documentIds: [alphaId, betaId],
    title,
  };
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
    await tx`DELETE FROM works WHERE project_id = ${fixture.projectId}`;
    await tx`DELETE FROM projects WHERE id = ${fixture.projectId}`;
  });
}

export async function resetUserOnboardingState(db: Db, userId: string): Promise<void> {
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
    await tx`DELETE FROM projects WHERE user_id = ${userId}::uuid`;
    await tx`
      INSERT INTO user_preferences (user_id, onboarding_state)
      VALUES (${userId}::uuid, '{}'::jsonb)
      ON CONFLICT (user_id) DO UPDATE SET onboarding_state = '{}'::jsonb
    `;
  });
}

export async function markOnboardingCompleted(
  db: Db,
  userId: string,
  projectId: string,
): Promise<void> {
  await db`
    INSERT INTO user_preferences (user_id, onboarding_state)
    VALUES (
      ${userId}::uuid,
      ${JSON.stringify({
        status: "completed",
        firstProjectId: projectId,
        completedSteps: ["basics", "profile", "path", "complete"],
      })}::jsonb
    )
    ON CONFLICT (user_id) DO UPDATE SET onboarding_state = EXCLUDED.onboarding_state
  `;
}
