/** PostgreSQL contract for an independent brief settling outside the source run. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createDrizzleHandoffBriefClaim } from "../adapters/drizzle-handoff-brief-claim.js";
import { createDrizzleRunClaim } from "../adapters/drizzle-run-claim.js";
import { createDrizzleThreadLock } from "../adapters/drizzle-thread-lock.js";
import { createHandoffBriefs } from "./brief-service.js";

const url = process.env.DATABASE_URL;
const run = !!url && ["1", "true"].includes(process.env.RUN_DB_TESTS ?? "");

if (!run) describe.skip("handoff brief service (postgres)", () => {});
else
  describe("handoff brief service (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
    const { executionScenario } = await import("../../../test-support/execution-scenario.js");
    const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
    const { handoffSeedMetadata } = await import("../../threads/index.js");
    assertThrowawayDatabaseForRunDbTests(url!);
    const db = createDb(url!, { max: 8 });
    beforeEach(() => deleteDrizzleRows(db, [schema.users]));
    afterAll(() => db.close());

    it("settles a pending seed without acquiring or mutating the source run", async () => {
      const { ids, repos } = await executionScenario(db);
      const source = (await repos.threads.findById(ids.caller))!;
      const cutoff = (await repos.turns.findById(ids.callerTurn))!;
      const destination = await repos.threads.create({
        userId: ids.user,
        projectId: ids.project,
        title: "Handoff destination",
      });
      const seed = await repos.turns.create({
        threadId: destination.id,
        role: "system",
        origin: "system",
        status: "pending",
        metadata: handoffSeedMetadata({
          sourceThreadId: source.id,
          sourceRef: source.ref!,
          sourceTitle: source.title,
          cutoffTurnId: cutoff.id,
        }),
      });
      const runClaim = createDrizzleRunClaim(db, { holderId: "source-run" });
      const sourceLease = await runClaim.startExecution(source.id, "source-running");
      expect(sourceLease).not.toBeNull();
      const sourceTurnsBefore = await repos.turns.listByThread(source.id);
      const sourceInboxBefore = await db
        .select()
        .from(schema.threadInboxMessages)
        .where(eq(schema.threadInboxMessages.threadId, source.id));
      const eventWriter = createDrizzleEventJournalWriter(db);
      const statusReader = (await import("../adapters/drizzle-handoff-status-reader.js"))
        .createDrizzleHandoffStatusReader(db, runClaim);
      expect(await repos.turns.hasPendingHandoffSeed(destination.id)).toBe(true);
      expect(await statusReader.read(destination.id)).toMatchObject({
        kind: "awake",
        phase: "generating",
      });

      let wakes = 0;
      const published: unknown[] = [];
      const postCommit: Array<() => Promise<void>> = [];
      const service = createHandoffBriefs({
        repos,
        eventWriter,
        eventSink: createInMemoryEventSink(),
        threadLock: createDrizzleThreadLock(db),
        claim: createDrizzleHandoffBriefClaim(db),
        runClaim,
        runStarter: { async start(threadId) { if (threadId === destination.id) wakes += 1; } },
        billingUsage: { async canStartTurn() { return true; } },
        async generate() {
          return {
            outcome: {
              kind: "complete",
              text: "The jade gate is open.",
              model: "gpt-4.1-mini",
              modelResponses: [],
              summarizer: { path: "branch", segments: 1 },
            },
          };
        },
        async publishStatus(threadId) {
          published.push({ threadId, status: await statusReader.read(threadId) });
        },
        schedulePostCommit(task) { postCommit.push(task); },
      });

      await service.launch(seed.id);
      await Promise.all(postCommit.splice(0).map((task) => task()));

      expect(await repos.turns.findById(seed.id)).toMatchObject({ status: "complete" });
      expect(await repos.turns.hasPendingHandoffSeed(destination.id)).toBe(false);
      expect(await repos.blocks.listByTurn(seed.id)).toHaveLength(1);
      expect(await statusReader.read(destination.id)).toEqual({ kind: "asleep" });
      expect(wakes).toBe(1);
      expect(published).toHaveLength(2);
      expect(await runClaim.read(source.id)).toMatchObject({ kind: "awake" });
      expect(await repos.turns.listByThread(source.id)).toEqual(sourceTurnsBefore);
      expect(
        await db
          .select()
          .from(schema.threadInboxMessages)
          .where(eq(schema.threadInboxMessages.threadId, source.id)),
      ).toEqual(sourceInboxBefore);
      await runClaim.release(sourceLease!);
    });
  });
