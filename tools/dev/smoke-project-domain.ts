/**
 * Manual/runtime smoke for Meridian project, work, and thread repositories
 * against the local Postgres database.
 *
 * Run after `pnpm dev:infra` and `pnpm bootstrap` (schema):
 *   pnpm smoke:project-domain
 */

import { resolve } from "node:path";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { createDb, projects } from "@meridian/database";
import { eq } from "drizzle-orm";
import { createDrizzleProjectRepository } from "../../apps/server/server/domains/projects/adapters/project-repository/drizzle.ts";
import { createDrizzleWorkRepository } from "../../apps/server/server/domains/projects/adapters/work-repository/drizzle.ts";
import { createDrizzleRepositories } from "../../apps/server/server/domains/threads/adapters/drizzle/repositories.ts";
import { applyDevEnvToProcess } from "./lib/dev-env";

const repoRoot = resolve(import.meta.dirname, "../..");
applyDevEnvToProcess(repoRoot);

const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const OTHER_USER_ID = "11111111-1111-4111-8111-111111111102" as UserId;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env, run pnpm dev:infra, and set DATABASE_URL.`,
    );
  }
  return value;
}

async function ensureSmokeUserId(databaseUrl: string): Promise<UserId> {
  const externalId = requireEnv("WORKOS_DEV_LOGIN_USER_ID");
  const email = process.env.WORKOS_DEV_LOGIN_EMAIL?.trim() || "test@meridian.dev";
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO public.users (external_id, email, created_at, updated_at)
      VALUES (${externalId}, ${email}, now(), now())
      ON CONFLICT (external_id) DO UPDATE
      SET email = EXCLUDED.email, updated_at = now()
      RETURNING id::text
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error("ensureSmokeUserId did not return an internal user id");
    return id as UserId;
  } finally {
    await sql.end();
  }
}

async function resolveSmokeUserId(): Promise<UserId> {
  const explicit = process.env.TEST_USER_ID?.trim();
  if (explicit) return explicit as UserId;

  const databaseUrl = requireEnv("DATABASE_URL");
  return ensureSmokeUserId(databaseUrl);
}

async function cleanupSmokeRows(db: ReturnType<typeof createDb>): Promise<void> {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const userId = await resolveSmokeUserId();
  const db = createDb(databaseUrl, { max: 1 });

  try {
    await cleanupSmokeRows(db);

    const repos = {
      projects: createDrizzleProjectRepository({ db }),
      works: createDrizzleWorkRepository({ db }),
      ...createDrizzleRepositories(db),
    };

    console.log("1. create + list");
    const created = await repos.projects.create({
      id: PROJECT_ID,
      userId,
      title: "Project Smoke",
      description: "bones",
    });
    const listed = await repos.projects.listByUser(userId);
    if (!listed.some((project) => project.id === created.id)) {
      throw new Error(`list failed: ${JSON.stringify(listed)}`);
    }

    console.log("2. search");
    const searchHit = await repos.projects.search(userId, "bone");
    if (searchHit.length !== 1 || searchHit[0]?.id !== PROJECT_ID) {
      throw new Error(`search failed: ${JSON.stringify(searchHit)}`);
    }

    console.log("3. update");
    const updated = await repos.projects.update(PROJECT_ID, {
      title: "Renamed Smoke",
      description: "About bones",
    });
    if (updated.title !== "Renamed Smoke") {
      throw new Error("update title failed");
    }

    console.log("4. work in project");
    const work = await repos.works.ensureDefaultForProject(PROJECT_ID, "Default Work");
    const works = await repos.works.listByProject(PROJECT_ID);
    if (works.length !== 1 || works[0]?.id !== work.id) {
      throw new Error(`listWorks failed: ${JSON.stringify(works)}`);
    }

    console.log("5. thread in project");
    const thread = await repos.threads.create({
      userId,
      projectId: PROJECT_ID,
      workId: work.id,
      title: "Chat",
    });
    const threads = await repos.threads.listByProject(PROJECT_ID);
    if (threads.length !== 1 || threads[0]?.id !== thread.id) {
      throw new Error(`listThreads failed: ${JSON.stringify(threads)}`);
    }

    console.log("6. touch");
    const beforeTouch = updated.updatedAt;
    await new Promise((resolveTouch) => setTimeout(resolveTouch, 10));
    await repos.projects.touch(PROJECT_ID);
    const afterTouch = await repos.projects.findById(PROJECT_ID);
    if (!afterTouch || afterTouch.updatedAt <= beforeTouch) {
      throw new Error("touch did not bump updatedAt");
    }

    console.log("7. owner isolation");
    const otherList = await repos.projects.listByUser(OTHER_USER_ID);
    if (otherList.some((project) => project.id === PROJECT_ID)) {
      throw new Error("other user should not see smoke project");
    }

    console.log("8. soft delete hides child threads");
    await repos.projects.softDelete(PROJECT_ID);
    if (await repos.threads.findById(thread.id)) {
      throw new Error("thread still visible after parent project soft-delete");
    }
    const afterDeleteList = await repos.projects.listByUser(userId);
    if (afterDeleteList.some((project) => project.id === PROJECT_ID)) {
      throw new Error("soft-deleted project still listed");
    }

    console.log("OK — all repository smoke checks passed");
  } finally {
    await cleanupSmokeRows(db);
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
