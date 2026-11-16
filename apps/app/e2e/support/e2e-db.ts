import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devAuthIdentity } from "@meridian/contracts/dev-auth";
import { deserializeTransport } from "@meridian/contracts/protocol";
import type { APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import { applyDevEnvToProcess } from "../../../../tools/dev/lib/dev-env";

// Every DB-using spec imports this module before it reads `DATABASE_URL`, so a
// run from a bare shell finds the checkout's database instead of skipping.
applyDevEnvToProcess();

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

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
  const title = `${input.titlePrefix} ${projectId.slice(0, 8)}`;

  // The product's own routes provision the project (with its No Work row), the Work and the
  // thread; its sources come with the project.
  await postJson(request, "/api/projects", { commandId: randomUUID(), id: projectId, title });
  await postJson(request, `/api/projects/${projectId}/works`, {
    commandId: randomUUID(),
    id: workId,
    name: "Main Arc",
  });
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

  try {
    const alphaId = createFixtureDocument(projectId, {
      path: "/alpha.md",
      content: "# Alpha\n\nSeed context.",
    });
    const betaId = createFixtureDocument(projectId, {
      path: "/beta.md",
      content: "# Beta\n\nSeed context.",
    });

    return {
      projectId,
      workId,
      threadId,
      documentIds: [alphaId, betaId],
      title,
    };
  } catch (error) {
    await cleanupProjectFixture(db, {
      projectId,
      workId,
      threadId,
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

// Documents are created through the project's tree list on the Yjs socket, which `./mf doc put`
// drives; no HTTP route makes one.
function createFixtureDocument(
  projectId: string,
  input: { path: string; content: string },
): string {
  const uri = `kb://${input.path.replace(/^\//, "").replace(/\.md$/, "")}`;
  const output = execFileSync(
    "./mf",
    ["doc", "put", uri, "--project", projectId, "--text", input.content, "--json"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // Playwright's FORCE_COLOR puts ANSI codes in the portless list mf reads its routes from.
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    },
  );
  const { documentId } = JSON.parse(output) as { documentId?: unknown };
  if (typeof documentId !== "string") {
    throw new Error(`Fixture document ${input.path}: mf returned no document ID`);
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
