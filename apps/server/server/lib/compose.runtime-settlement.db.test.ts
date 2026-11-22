/**
 * Production-composition regression for a removed bound model.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - typed removed-model failure
 */

import { toolContentText } from "@meridian/contracts/threads";
import { beforeEach, describe, expect, it } from "vitest";
import { treeSeeder } from "../test-support/tree-seed.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("production-composed removed bound model (postgres)", () => {});
} else {
  describe("production-composed removed bound model (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../test-support/drizzle-reset.js"
    );
    const { unloadHocuspocus, useComposedRuntimes } = await import(
      "../test-support/composed-runtime.js"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000901";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000902";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000903";
    const WORK_ID = "00000000-0000-4000-8000-000000000904";
    const THREAD_ID = "00000000-0000-4000-8000-000000000905";
    const TURN_ID = "00000000-0000-4000-8000-000000000906";
    const DOC_ID = "00000000-0000-4000-8000-000000000907";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;
    const runtimes = useComposedRuntimes(() => db);
    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "runtime-settlement"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Runtime settlement",
        slug: "runtime-settlement",
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Runtime settlement",
        handle: "w1",
        defaultAiWriteMode: "direct",
      });
      await db.insert(schema.contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        slug: "manuscript",
        scope: "project",
      });
      await treeSeeder(db).document(SOURCE_ID, "runtime-settlement", { id: DOC_ID });
      await db.insert(schema.threads).values({
        rootThreadId: THREAD_ID,
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Runtime settlement",
        kind: "primary",
      });
      await db.insert(schema.turns).values({
        id: TURN_ID,
        threadId: THREAD_ID,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    it("returns a structured history tool error for a removed bound model", async () => {
      const runtime = await runtimes.compose();
      try {
        await runtime.app.agentRevisions.bindThread(
          THREAD_ID,
          null,
          {
            model: "removed-history-model",
            skills: { load: [], available: [] },
            namedTargets: [],
            permission: "edit" as const,
          },
          null,
        );
        const result = await runtime.app.toolExecutor.executeTool(
          {
            id: "history-unavailable",
            name: "thread_history",
            arguments: {},
          },
          { threadId: THREAD_ID, turnId: TURN_ID, agentSlug: null },
        );
        // The refusal keeps its typed shape beside the rendered text.
        expect(result).toMatchObject({
          isError: true,
          result: { code: "model_unavailable", message: "Model not found: removed-history-model" },
        });
        expect(toolContentText(result.content)).toBe(
          "Model not found: removed-history-model (model_unavailable)",
        );
      } finally {
        await unloadHocuspocus(runtime.hocuspocus);
      }
    });
  });
}
