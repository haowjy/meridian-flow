import { randomUUID } from "node:crypto";
import { devAuthIdentity } from "@meridian/contracts/dev-auth";
import { deserializeTransport } from "@meridian/contracts/protocol";
import type { APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import { applyDevEnvToProcess } from "../../../../tools/dev/lib/dev-env";

// Every DB-using spec imports this module before it reads `DATABASE_URL`, so a
// run from a bare shell finds the checkout's database instead of skipping.
applyDevEnvToProcess();

export type Db = ReturnType<typeof postgres>;

export function openE2eDb(databaseUrl: string): Db {
  return postgres(databaseUrl, { max: 1 });
}

/** Idempotent e2e fixture user: the dev auth bypass user, without depending on a prior sign-in. */
export async function ensureTestUserId(db: Db): Promise<string> {
  const { externalId: externalUserId, email } = devAuthIdentity(process.env);
  const rows = await db<{ id: string }[]>`
    INSERT INTO public.users (external_id, email, created_at, updated_at)
    VALUES (${externalUserId}, ${email}, now(), now())
    ON CONFLICT (external_id) DO UPDATE
    SET email = EXCLUDED.email, updated_at = now()
    RETURNING id::text
  `;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(`Failed to ensure user row for external_id=${externalUserId}`);
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

  // The product's own routes provision the project (with its No Work row), the Work and the
  // thread; only the knowledge-base source below has no route.
  await postJson(request, "/api/projects", { id: projectId, title });
  await postJson(request, `/api/projects/${projectId}/works`, { id: workId, name: "Main Arc" });
  const agentsResponse = await request.get(`/api/agents?projectId=${projectId}&limit=100`);
  if (!agentsResponse.ok()) {
    throw new Error(
      `GET /api/agents failed: ${agentsResponse.status()} ${await agentsResponse.text()}`,
    );
  }
  const agents = deserializeTransport(
    (await agentsResponse.json()) as { agents: { slug: string; selection: unknown }[] },
  );
  const general = agents.agents.find((agent) => agent.slug === "general");
  if (!general) throw new Error("Fixture project has no general agent");
  await postJson(request, "/api/threads", {
    id: threadId,
    projectId,
    workId,
    title,
    agentSelection: general.selection,
  });

  await db.begin(async (tx) => {
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

async function postJson(request: APIRequestContext, path: string, data: unknown): Promise<void> {
  const response = await request.post(path, { data });
  if (!response.ok()) {
    throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`);
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
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`
      DELETE FROM turn_blocks
      WHERE turn_id IN (
        SELECT id FROM turns
        WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ${fixture.projectId})
      )
    `;
    await tx`
      DELETE FROM event_journal
      WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ${fixture.projectId})
    `;
    await tx`
      DELETE FROM thread_documents
      WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ${fixture.projectId})
    `;
    await tx`
      DELETE FROM turn_document_touches
      WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ${fixture.projectId})
    `;
    await tx`DELETE FROM project_results WHERE project_id = ${fixture.projectId}`;
    await tx`
      DELETE FROM turns
      WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ${fixture.projectId})
    `;
    await tx`DELETE FROM threads WHERE project_id = ${fixture.projectId}`;
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
    await tx`SET CONSTRAINTS ALL DEFERRED`;
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
 * Clear the dev user's projects so the next authenticated request provisions
 * a fresh personal project via ensureDefaultBootstrap.
 */
export async function prepareAuthenticatedProjectAccess(db: Db): Promise<void> {
  const userId = await ensureTestUserId(db);
  await resetUserProjects(db, userId);
}
