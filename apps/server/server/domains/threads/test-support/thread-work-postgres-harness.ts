/** Shared destructive seed for PostgreSQL thread Work race suites. */
import type { Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { truncateDrizzleTables } from "../../../test-support/drizzle-reset.js";

export const THREAD_WORK_RACE = {
  userId: "00000000-0000-4000-8000-000000000471",
  projectId: "00000000-0000-4000-8000-000000000472",
  threadId: "00000000-0000-4000-8000-000000000473",
  workId: "00000000-0000-4000-8000-000000000474",
  targetWorkId: "00000000-0000-4000-8000-000000000475",
  contextId: "00000000-0000-4000-8000-000000000476",
  documentId: "00000000-0000-4000-8000-000000000477",
  branchId: "branch_work_lifecycle_race",
} as const;

export async function resetThreadWorkRaceFixture(db: Database): Promise<void> {
  const ids = THREAD_WORK_RACE;
  await truncateDrizzleTables(db, [schema.users]);
  await db.insert(schema.users).values(conformanceUserValues(ids.userId, "work-lifecycle-race"));
  await db.insert(schema.projects).values({
    id: ids.projectId,
    userId: ids.userId,
    name: "Work Lifecycle Race",
    slug: "work-lifecycle-race",
  });
  await db.insert(schema.works).values([
    {
      id: ids.workId,
      projectId: ids.projectId,
      createdByUserId: ids.userId,
      name: "Race target",
      slug: "race-target",
    },
    {
      id: ids.targetWorkId,
      projectId: ids.projectId,
      createdByUserId: ids.userId,
      name: "Rebound target",
      slug: "rebound-target",
      status: "archived",
      archivedAt: new Date(),
    },
  ]);
  await db.insert(schema.threads).values({
    id: ids.threadId,
    projectId: ids.projectId,
    createdByUserId: ids.userId,
    title: "Race thread",
    kind: "primary",
    status: "idle",
  });
  await db.insert(schema.contextSources).values({
    id: ids.contextId,
    projectId: ids.projectId,
    name: "Project context",
    slug: "project-context",
  });
  await db.insert(schema.documents).values({
    id: ids.documentId,
    contextSourceId: ids.contextId,
    name: "Draft target",
  });
  await db.insert(schema.documentBranches).values({
    id: ids.branchId,
    documentId: ids.documentId,
    kind: "work_draft",
    workId: ids.workId,
    state: Buffer.alloc(0),
    stateVector: Buffer.alloc(0),
  });
}
