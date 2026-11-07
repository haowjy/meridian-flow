/** PostgreSQL proof that trashing a chat cancels its live lineage and removes its Work feed row. */

import * as schema from "@meridian/database/schema";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { executionScenario } from "../../../test-support/execution-scenario.js";
import { createQuietDrizzleJournalWriter } from "../../../test-support/journal-writer.js";
import { createProjectRepositoryForTest } from "../../projects/test-support/project-repository.js";
import { createDrizzleRunClaim } from "../../runtime/adapters/drizzle-run-claim.js";
import { createTestDrizzleDelivery } from "../../runtime/loop/__tests__/test-drizzle-delivery.js";
import { createLineageCancellation } from "../../runtime/spawn/lineage-cancellation.js";
import { createDrizzleRepositoriesForTest } from "../adapters/drizzle/repositories.js";
import { deleteOwnedThreadToTrash } from "../thread-access.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

describe.skipIf(!enabled || !databaseUrl)("thread trash lifecycle (postgres)", async () => {
  const { createDb } = await import("@meridian/database");
  const db = createDb(databaseUrl ?? "", { max: 8 });

  beforeEach(() => deleteDrizzleRows(db, [schema.users]));
  afterAll(() => db.close());

  it("cancels a running reply and its subtree before removing the chat from its Work feed", async () => {
    const scenario = await executionScenario(db);
    const { ids, repos } = scenario;
    const workId = crypto.randomUUID();
    const rootExecutionId = crypto.randomUUID();
    const childExecutionId = crypto.randomUUID();
    await db
      .update(schema.turns)
      .set({ status: "streaming" })
      .where(eq(schema.turns.id, ids.callerTurn));

    await db.insert(schema.works).values({
      id: workId,
      projectId: ids.project,
      createdByUserId: ids.user,
      name: "Trash test Work",
      handle: "w1",
    });
    await db.insert(schema.threadWorks).values({
      threadId: ids.caller,
      workId,
      projectId: ids.project,
      isPrimary: true,
    });
    await db.insert(schema.threadRunLeases).values([
      {
        threadId: ids.caller,
        executionId: rootExecutionId,
        boundTurnIds: [ids.callerTurn],
        turnId: ids.callerTurn,
        holderId: "trash-test-root",
        phase: "generating",
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        threadId: ids.child,
        executionId: childExecutionId,
        boundTurnIds: [ids.execution],
        turnId: ids.execution,
        holderId: "trash-test-child",
        phase: "generating",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    const runClaim = createDrizzleRunClaim(db, { holderId: "trash-test" });
    const eventWriter = createQuietDrizzleJournalWriter(db);
    const delivery = createTestDrizzleDelivery(db, { repos, eventWriter, runClaim });
    const lineage = createLineageCancellation({
      transaction: repos.transaction,
      threads: repos.threads,
      runClaim,
      delivery,
      asks: { recordCancelled: async () => {} },
      askRows: repos.asks,
      reports: repos.executionReports,
      refreshActivity: () => {},
      afterCommit: () => {},
    });
    const projects = createProjectRepositoryForTest({ db });
    const threadRepos = createDrizzleRepositoriesForTest(db);

    await deleteOwnedThreadToTrash(
      {
        repos: threadRepos,
        projects,
        works: { findById: async () => null, findNoWork: async () => null },
        workContextNotices: {
          threadChanged: async () => {},
          materializeIdle: async () => "delivered" as const,
        },
        workAuthorityResolver: {} as never,
        stopThreads: async (threadIds) => {
          for (const threadId of threadIds) {
            await lineage.cancel(threadId, async () => ({
              result: undefined,
              reach: { kind: "deleted" as const },
              execution: null,
            }));
          }
        },
      },
      ids.caller,
      ids.user,
    );

    const leases = await db
      .select({
        threadId: schema.threadRunLeases.threadId,
        cancelRequested: schema.threadRunLeases.cancelRequested,
      })
      .from(schema.threadRunLeases)
      .where(inArray(schema.threadRunLeases.threadId, [ids.caller, ids.child]));
    expect(leases).toEqual([
      { threadId: ids.caller, cancelRequested: true },
      { threadId: ids.child, cancelRequested: true },
    ]);
    expect(
      await db
        .select({ deletedAt: schema.threads.deletedAt })
        .from(schema.threads)
        .where(eq(schema.threads.id, ids.caller)),
    ).toEqual([{ deletedAt: expect.any(Date) }]);

    const feed = await threadRepos.chatFeed.queryPage({
      projectId: ids.project,
      userId: ids.user,
      after: null,
      limit: 20,
      favorite: false,
      workId,
      search: null,
    });
    expect(feed.map((item) => item.id)).not.toContain(ids.caller);
  });
});
