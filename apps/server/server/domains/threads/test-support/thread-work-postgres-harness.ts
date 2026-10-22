/** Shared destructive seed for PostgreSQL thread Work race suites. */
import type { Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";

export const THREAD_WORK_RACE = {
  userId: "00000000-0000-4000-8000-000000000471",
  projectId: "00000000-0000-4000-8000-000000000472",
  threadId: "00000000-0000-4000-8000-000000000473",
  workId: "00000000-0000-4000-8000-000000000474",
  targetWorkId: "00000000-0000-4000-8000-000000000475",
  contextId: "00000000-0000-4000-8000-000000000476",
  documentId: "00000000-0000-4000-8000-000000000477",
  noWorkId: "00000000-0000-4000-8000-000000000478",
  branchId: "00000000-0000-4000-8000-000000000479",
  draftId: "draft_work_lifecycle_race",
} as const;

export async function resetThreadWorkRaceFixture(db: Database): Promise<void> {
  const ids = THREAD_WORK_RACE;
  await deleteDrizzleRows(db, [schema.users]);
  await db.insert(schema.users).values(conformanceUserValues(ids.userId, "work-lifecycle-race"));
  await db.insert(schema.projects).values({
    id: ids.projectId,
    userId: ids.userId,
    name: "Work Lifecycle Race",
    slug: "work-lifecycle-race",
  });
  await db.insert(schema.works).values([
    {
      id: ids.noWorkId,
      projectId: ids.projectId,
      createdByUserId: ids.userId,
      name: "No Work",
      handle: null,
      isNoWork: true,
    },
    {
      id: ids.workId,
      projectId: ids.projectId,
      createdByUserId: ids.userId,
      name: "Race target",
      handle: "w2",
    },
    {
      id: ids.targetWorkId,
      projectId: ids.projectId,
      createdByUserId: ids.userId,
      name: "Rebound target",
      handle: "w3",
      archivedAt: new Date(),
    },
  ]);
  await db.insert(schema.threads).values({
    rootThreadId: ids.threadId,
    id: ids.threadId,
    projectId: ids.projectId,
    createdByUserId: ids.userId,
    title: "Race thread",
    ref: "c900",
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
    name: "Branch target",
  });
  await db.insert(schema.branches).values({
    id: ids.branchId,
    projectId: ids.projectId,
    originWorkId: ids.workId,
    createdBy: ids.userId,
  });
  await db.insert(schema.documentDrafts).values({
    id: ids.draftId,
    documentId: ids.documentId,
    kind: "work_draft",
    branchId: ids.branchId,
    state: Buffer.from([0, 0]),
    stateVector: Buffer.from([0]),
  });
}
