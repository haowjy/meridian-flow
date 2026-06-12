/**
 * Manual/runtime smoke for Meridian workbench, work, and thread repositories
 * against the local Supabase/Postgres database.
 *
 * Run after `pnpm supabase:start` and `pnpm bootstrap`:
 *   pnpm smoke:workbench-domain
 */

import { resolve } from "node:path";
import type { UserId, WorkbenchId } from "@meridian/contracts/runtime";
import { createDb, projects } from "@meridian/database";
import { eq } from "drizzle-orm";
import { createDrizzleRepositories } from "../../apps/server/server/domains/threads/adapters/drizzle/repositories.ts";
import { createDrizzleWorkRepository } from "../../apps/server/server/domains/workbenches/adapters/work-repository/drizzle.ts";
import { createDrizzleWorkbenchRepository } from "../../apps/server/server/domains/workbenches/adapters/workbench-repository/drizzle.ts";
import { loadRepoEnv, requireEnv } from "./load-env.ts";
import { SupabaseAdminClient } from "./supabase-admin.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
loadRepoEnv(repoRoot);

const WORKBENCH_ID = "11111111-1111-4111-8111-111111111111" as WorkbenchId;
const OTHER_USER_ID = "11111111-1111-4111-8111-111111111102" as UserId;

async function resolveSmokeUserId(): Promise<UserId> {
  const explicit = process.env.TEST_USER_ID?.trim();
  if (explicit) return explicit as UserId;

  const admin = new SupabaseAdminClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
  const email = process.env.TEST_USER_EMAIL ?? "smoke@meridian.dev";
  const password = process.env.TEST_USER_PASSWORD ?? "meridian-dev";
  return (await admin.ensureUser(email, password)) as UserId;
}

async function cleanupSmokeRows(db: ReturnType<typeof createDb>): Promise<void> {
  await db.delete(projects).where(eq(projects.id, WORKBENCH_ID));
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const userId = await resolveSmokeUserId();
  const db = createDb(databaseUrl, { max: 1 });

  try {
    await cleanupSmokeRows(db);

    const repos = {
      workbenches: createDrizzleWorkbenchRepository({ db }),
      works: createDrizzleWorkRepository({ db }),
      ...createDrizzleRepositories(db),
    };

    console.log("1. create + list");
    const created = await repos.workbenches.create({
      id: WORKBENCH_ID,
      userId,
      title: "Workbench Smoke",
      description: "bones",
    });
    const listed = await repos.workbenches.listByUser(userId);
    if (!listed.some((workbench) => workbench.id === created.id)) {
      throw new Error(`list failed: ${JSON.stringify(listed)}`);
    }

    console.log("2. search");
    const searchHit = await repos.workbenches.search(userId, "bone");
    if (searchHit.length !== 1 || searchHit[0]?.id !== WORKBENCH_ID) {
      throw new Error(`search failed: ${JSON.stringify(searchHit)}`);
    }

    console.log("3. update");
    const updated = await repos.workbenches.update(WORKBENCH_ID, {
      title: "Renamed Smoke",
      description: "About bones",
    });
    if (updated.title !== "Renamed Smoke") {
      throw new Error("update title failed");
    }

    console.log("4. work in workbench");
    const work = await repos.works.ensureDefaultForWorkbench(WORKBENCH_ID, "Default Work");
    const works = await repos.works.listByWorkbench(WORKBENCH_ID);
    if (works.length !== 1 || works[0]?.id !== work.id) {
      throw new Error(`listWorks failed: ${JSON.stringify(works)}`);
    }

    console.log("5. thread in workbench");
    const thread = await repos.threads.create({
      userId,
      workbenchId: WORKBENCH_ID,
      workId: work.id,
      title: "Chat",
    });
    const threads = await repos.threads.listByWorkbench(WORKBENCH_ID);
    if (threads.length !== 1 || threads[0]?.id !== thread.id) {
      throw new Error(`listThreads failed: ${JSON.stringify(threads)}`);
    }

    console.log("6. touch");
    const beforeTouch = updated.updatedAt;
    await new Promise((resolveTouch) => setTimeout(resolveTouch, 10));
    await repos.workbenches.touch(WORKBENCH_ID);
    const afterTouch = await repos.workbenches.findById(WORKBENCH_ID);
    if (!afterTouch || afterTouch.updatedAt <= beforeTouch) {
      throw new Error("touch did not bump updatedAt");
    }

    console.log("7. owner isolation");
    const otherList = await repos.workbenches.listByUser(OTHER_USER_ID);
    if (otherList.some((workbench) => workbench.id === WORKBENCH_ID)) {
      throw new Error("other user should not see smoke workbench");
    }

    console.log("8. soft delete hides child threads");
    await repos.workbenches.softDelete(WORKBENCH_ID);
    if (await repos.threads.findById(thread.id)) {
      throw new Error("thread still visible after parent workbench soft-delete");
    }
    const afterDeleteList = await repos.workbenches.listByUser(userId);
    if (afterDeleteList.some((workbench) => workbench.id === WORKBENCH_ID)) {
      throw new Error("soft-deleted workbench still listed");
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
