/** PostgreSQL contract: a failed assistant turn keeps its terminal status when the writer moves on. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEventHub } from "../../thread-event-hub.js";
import { buildThreadSnapshot } from "../../thread-snapshot.js";

const runDb = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

if (!runDb || !databaseUrl) describe.skip("failed reply projection (postgres)", () => {});
else
  describe("failed reply projection (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
    const { projectReadModelEvent } = await import("../../domain/read-model-projector.js");

    const ids = {
      user: "00000000-0000-4000-8000-000000000d11",
      project: "00000000-0000-4000-8000-000000000d12",
      thread: "00000000-0000-4000-8000-000000000d13" as ThreadId,
      failed: "00000000-0000-4000-8000-000000000d14" as TurnId,
      nextUser: "00000000-0000-4000-8000-000000000d15" as TurnId,
      secondFailed: "00000000-0000-4000-8000-000000000d16" as TurnId,
      thirdUser: "00000000-0000-4000-8000-000000000d17" as TurnId,
    };
    assertThrowawayDatabaseForRunDbTests(databaseUrl);
    const db = createDb(databaseUrl, { max: 3 });
    const repos = createDrizzleRepositoriesForTest(db);

    async function failedAssistant(id: TurnId, prevTurnId: TurnId | null, error: string) {
      await repos.turns.create({
        id,
        threadId: ids.thread,
        prevTurnId,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
      });
      await repos.turns.updateStatus(id, { status: "error", finishReason: "error", error });
    }

    async function projectWriterTurn(id: TurnId, prevTurnId: TurnId) {
      const turn = await repos.turns.create({
        id,
        threadId: ids.thread,
        prevTurnId,
        role: "user",
        origin: "writer",
        status: "pending",
      });
      await projectReadModelEvent(repos, { type: "turn.created", turn });
    }

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(ids.user, "failed-reply"));
      await db
        .insert(schema.projects)
        .values({ id: ids.project, userId: ids.user, name: "Failure", slug: "failure" });
      await db.insert(schema.threads).values({
        id: ids.thread,
        rootThreadId: ids.thread,
        projectId: ids.project,
        createdByUserId: ids.user,
      });
      await failedAssistant(ids.failed, null, "provider unavailable");
    });
    afterAll(async () => db.close());

    it("keeps each of consecutive failures errored in the snapshot", async () => {
      await projectWriterTurn(ids.nextUser, ids.failed);
      await failedAssistant(ids.secondFailed, ids.nextUser, "rate limited");
      await projectWriterTurn(ids.thirdUser, ids.secondFailed);

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
      const assistants = snapshot.turns.filter((turn) => turn.role === "assistant");
      expect(assistants.map(({ id, status, error }) => ({ id, status, error }))).toEqual([
        { id: ids.failed, status: "error", error: "provider unavailable" },
        { id: ids.secondFailed, status: "error", error: "rate limited" },
      ]);
    });
  });
