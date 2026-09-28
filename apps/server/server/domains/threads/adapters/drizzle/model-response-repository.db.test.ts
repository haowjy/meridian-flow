/** PostgreSQL contract for model-response timing through projection and snapshot reads. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { modelResponseTimingFields } from "../../../runtime/loop/model-response-timing.js";
import type { ThreadEventHub } from "../../thread-event-hub.js";
import { buildThreadSnapshot } from "../../thread-snapshot.js";

const runDb = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

if (!runDb || !databaseUrl) describe.skip("model response timing (postgres)", () => {});
else
  describe("model response timing (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
    const { projectReadModelEvent } = await import("../../domain/read-model-projector.js");

    const ids = {
      user: "00000000-0000-4000-8000-000000000bc1",
      project: "00000000-0000-4000-8000-000000000bc2",
      thread: "00000000-0000-4000-8000-000000000bc3" as ThreadId,
      turn: "00000000-0000-4000-8000-000000000bc4" as TurnId,
      response: "00000000-0000-4000-8000-000000000bc5",
    };
    assertThrowawayDatabaseForRunDbTests(databaseUrl);
    const db = createDb(databaseUrl, { max: 3 });
    const repos = createDrizzleRepositoriesForTest(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(ids.user, "response-timing"));
      await db
        .insert(schema.projects)
        .values({ id: ids.project, userId: ids.user, name: "Timing", slug: "timing" });
      await db.insert(schema.threads).values({
        rootThreadId: ids.thread,
        id: ids.thread,
        projectId: ids.project,
        createdByUserId: ids.user,
      });
      await repos.turns.create({
        id: ids.turn,
        threadId: ids.thread,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
    });
    afterAll(async () => db.close());

    it("persists result timing through model-response projection and thread snapshots", async () => {
      const result = {
        timing: {
          requestStartedAt: "2026-09-27T12:00:00.000Z",
          latencyMs: 240,
          timeToFirstTokenMs: 80,
          generationMs: 160,
        },
      };
      await projectReadModelEvent(repos, {
        type: "model.response_received",
        response: {
          id: ids.response,
          turnId: ids.turn,
          sequence: 0,
          provider: "test-provider",
          model: "test-model",
          priceSource: "unknown",
          inputTokens: 12,
          outputTokens: 3,
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
          ...modelResponseTimingFields(result),
        },
      });

      await expect(repos.modelResponses.listByTurn(ids.turn)).resolves.toMatchObject([
        {
          requestStartedAt: "2026-09-27T12:00:00.000Z",
          latencyMs: 240,
          timeToFirstTokenMs: 80,
          generationMs: 160,
        },
      ]);

      const hub = {
        async headSeq() {
          return 0n;
        },
        async readModelProjectionWatermark() {
          return 0n;
        },
      } as unknown as ThreadEventHub;
      const statusReader = {
        async read() {
          return { kind: "asleep" as const };
        },
        async readRunningTurnId() {
          return null;
        },
        async readMany() {
          return new Map();
        },
        async readPending() {
          return { items: [] };
        },
      };
      const snapshot = await buildThreadSnapshot(repos, hub, statusReader, ids.thread);
      expect(snapshot.turns[0]?.responses[0]).toMatchObject({
        requestStartedAt: "2026-09-27T12:00:00.000Z",
        latencyMs: 240,
        timeToFirstTokenMs: 80,
        generationMs: 160,
      });
    });
  });
