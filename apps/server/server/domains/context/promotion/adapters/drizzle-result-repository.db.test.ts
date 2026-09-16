/** Durable reconciliation contract for caller-owned promotion result identity. */

import { setTimeout as delay } from "node:timers/promises";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { projectResults, projects, threads, turns, users } from "@meridian/database/schema";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { truncateDrizzleTables } from "../../../../test-support/drizzle-reset.js";
import type { CreateProjectResultInput } from "../ports/result-repository.js";
import { createDrizzleResultRepository } from "./drizzle-result-repository.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("result repository reconciliation (postgres)", () => {});
} else {
  describe("result repository reconciliation (postgres)", async () => {
    const USER_ID = "00000000-0000-4000-8000-000000000a01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000a02";
    const THREAD_ID = "00000000-0000-4000-8000-000000000a03";
    const TURN_ID = "00000000-0000-4000-8000-000000000a04";
    const RESULT_ID = "00000000-0000-4000-8000-000000000a05";
    const { createDb } = await import("@meridian/database");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const observer = postgres(DATABASE_URL, { max: 1 });

    const input: CreateProjectResultInput = {
      id: RESULT_ID,
      projectId: PROJECT_ID,
      sourcePath: "reports/final.txt",
      resultsUri: "results://@/threads/root/reports/final.txt",
      storageUrl: "memory://result",
      mimeType: "text/plain",
      sizeBytes: 5,
      provenance: {
        rootThreadId: THREAD_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        toolCallId: "call-1",
        agentSlug: "writer",
      },
    };

    beforeEach(async () => {
      await truncateDrizzleTables(db, [users]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "result-reconciliation"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Result reconciliation",
        slug: "result-reconciliation",
      });
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
      });
      await db.insert(turns).values({ id: TURN_ID, threadId: THREAD_ID, role: "assistant" });
    });

    afterAll(async () => {
      await control.end();
      await observer.end();
      await db.close();
    });

    async function waitForTransactionLock(): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await observer<{ count: string }[]>`
          SELECT count(*)::text AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event = 'transactionid'
        `;
        if (Number(row?.count ?? 0) >= 1) return;
        await delay(10);
      }
      throw new Error("Timed out waiting for result reconciliation transaction lock");
    }

    it("serializes concurrent unresolved callers on the same result identity", async () => {
      const repository = createDrizzleResultRepository(db);
      const outcomes = await Promise.all([
        repository.createOrConverge(input),
        repository.createOrConverge(input),
      ]);

      expect(outcomes.map((outcome) => outcome.kind)).toEqual(["committed", "committed"]);
      await expect(db.select().from(projectResults)).resolves.toHaveLength(1);
    });

    it("waits for an unresolved first insert and converges without deleting retained bytes", async () => {
      let inserted!: () => void;
      const insertVisibleInTransaction = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      let release!: () => void;
      const holdOutcome = new Promise<void>((resolve) => {
        release = resolve;
      });
      const retainedObject = new Map([[input.storageUrl, Uint8Array.from([1, 2, 3, 4, 5])]]);

      const unresolvedFirst = control.begin(async (transaction) => {
        await transaction`
          INSERT INTO project_results (
            id, project_id, source_path, results_uri, storage_url, mime_type, size_bytes,
            root_thread_id, thread_id, turn_id, tool_call_id, agent_slug
          ) VALUES (
            ${input.id}, ${input.projectId}, ${input.sourcePath}, ${input.resultsUri},
            ${input.storageUrl}, ${input.mimeType}, ${input.sizeBytes},
            ${input.provenance.rootThreadId}, ${input.provenance.threadId},
            ${input.provenance.turnId}, ${input.provenance.toolCallId}, ${input.provenance.agentSlug}
          )
        `;
        inserted();
        await holdOutcome;
      });
      await insertVisibleInTransaction;

      const earlyRows = await observer<{ id: string }[]>`
        SELECT id FROM project_results WHERE id = ${input.id}
      `;
      expect(earlyRows).toEqual([]);
      expect(retainedObject.get(input.storageUrl)).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));

      const converging = createDrizzleResultRepository(db).createOrConverge(input);
      let converged = false;
      void converging.finally(() => {
        converged = true;
      });
      await waitForTransactionLock();
      expect(converged).toBe(false);
      expect(retainedObject.has(input.storageUrl)).toBe(true);

      release();
      await unresolvedFirst;
      await expect(converging).resolves.toMatchObject({
        kind: "committed",
        record: { id: input.id },
      });
      expect(retainedObject.get(input.storageUrl)).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
      await expect(db.select().from(projectResults)).resolves.toHaveLength(1);
    });

    it("converges an exact prior commit but never adopts a mismatched payload", async () => {
      const repository = createDrizzleResultRepository(db);
      await expect(repository.createOrConverge(input)).resolves.toMatchObject({
        kind: "committed",
      });
      await expect(repository.createOrConverge(input)).resolves.toMatchObject({
        kind: "committed",
      });
      await expect(
        repository.createOrConverge({ ...input, storageUrl: "memory://different" }),
      ).resolves.toEqual({
        kind: "unknown",
        error: "Result ID already has different payload",
      });
      await expect(db.select().from(projectResults)).resolves.toHaveLength(1);
    });
  });
}
