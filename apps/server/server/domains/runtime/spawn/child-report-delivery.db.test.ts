/**
 * PostgreSQL proof for durable child-report delivery: atomic enqueue, one-card
 * one-continuation flush, replay, rejected-epoch recovery, and the writer
 * interleave that leaves the obligation pending.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-0000000c1001";
const PROJECT_ID = "00000000-0000-4000-8000-0000000c1002";
const PARENT_ID = "00000000-0000-4000-8000-0000000c1003";
const CHILD_ID = "00000000-0000-4000-8000-0000000c1004";
const ORIGIN_TURN_ID = "00000000-0000-4000-8000-0000000c1005";
const REPORT_ID = "00000000-0000-4000-8000-0000000c1006";
const SUBMISSION_TEXT = "A background subagent has reported. Continue from its report.";
const REPORT_RESULT = {
  status: "completed" as const,
  report: { threadId: CHILD_ID, summary: "Draft ready", costMillicredits: 0 },
};

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("child report delivery (postgres)", () => {});
} else {
  describe("child report delivery (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { eq } = await import("drizzle-orm");
    const { createDrizzleEventJournalWriter } = await import(
      "../../threads/adapters/drizzle/event-writer.js"
    );
    const { createDrizzleRepositoriesForTest } = await import(
      "../../threads/adapters/drizzle/repositories.js"
    );
    const { createInMemoryThreadRunOwnership } = await import("../loop/thread-run-ownership.js");
    const { createDrizzleAdmissionRecords } = await import(
      "../admission/drizzle-admission-records.js"
    );
    const { canonicalAdmissionFingerprint, createHostTurnAdmission } = await import(
      "../admission/user-turn-admission.js"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createChildReportDelivery, CHILD_REPORT_CONTINUATION_TEXT } = await import(
      "./child-report-delivery.js"
    );

    const url = DATABASE_URL;
    const db = createDb(url, { max: 4 });
    const repos = createDrizzleRepositoriesForTest(db);
    const records = createDrizzleAdmissionRecords(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "child-report"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Child Report",
        slug: "child-report",
      });
      await db.insert(schema.threads).values({
        id: PARENT_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Parent",
        kind: "primary",
        status: "idle",
      });
      await db.insert(schema.threads).values({
        id: CHILD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Child",
        kind: "subagent",
        status: "idle",
        parentThreadId: PARENT_ID,
        rootThreadId: PARENT_ID,
        originTurnId: ORIGIN_TURN_ID,
        originType: "spawn",
        spawnStatus: "running",
        spawnDepth: 1,
      });
    });

    afterAll(async () => {
      await db.close();
    });

    /** A faithful stand-in for AdmissionTurnStarter: commits the turn pair and settles the record. */
    function acceptingStarter(seenMetadata: Array<unknown>) {
      return {
        async start(input: {
          admission: { threadId: string; submissionId: string };
          fingerprint: string;
          userTurnMetadata?: unknown;
        }) {
          const userTurnId = crypto.randomUUID();
          const assistantTurnId = crypto.randomUUID();
          const latest = await repos.turns.getLatestByThread(input.admission.threadId as never);
          seenMetadata.push(input.userTurnMetadata);
          await repos.transaction(async () => {
            await repos.turns.create({
              id: userTurnId as never,
              threadId: input.admission.threadId as never,
              prevTurnId: (latest?.id ?? null) as never,
              role: "user",
              status: "complete",
              metadata: (input.userTurnMetadata ?? null) as never,
            });
            await repos.turns.create({
              id: assistantTurnId as never,
              threadId: input.admission.threadId as never,
              prevTurnId: userTurnId as never,
              role: "assistant",
              status: "complete",
            });
            const settled = await records.accept({
              response: {
                kind: "accepted",
                threadId: input.admission.threadId as never,
                submissionId: input.admission.submissionId,
                userTurnId: userTurnId as never,
                assistantTurnId: assistantTurnId as never,
                resumeAfterSeq: "0",
                snapshotFloorNextSeq: "4",
              },
              fingerprint: input.fingerprint,
            });
            if (settled.kind === "winner") throw new Error("unexpected admission winner");
          });
          return {
            kind: "accepted" as const,
            threadId: input.admission.threadId as never,
            submissionId: input.admission.submissionId,
            userTurnId: userTurnId as never,
            assistantTurnId: assistantTurnId as never,
            resumeAfterSeq: "0",
            snapshotFloorNextSeq: "4",
          };
        },
      };
    }

    function composeDelivery(seenMetadata: Array<unknown> = []) {
      const runOwnership = createInMemoryThreadRunOwnership();
      const admission = createHostTurnAdmission({
        records,
        runOwnership,
        starter: acceptingStarter(seenMetadata) as never,
      });
      const delivery = createChildReportDelivery({
        repos,
        eventWriter: createDrizzleEventJournalWriter(db),
        admission,
        isThreadRunning: () => false,
        runOwnership,
        schedulePostCommit: () => {},
      });
      return { delivery, admission, runOwnership };
    }

    async function enqueueReport(delivery: ReturnType<typeof createChildReportDelivery>) {
      await delivery.enqueue({
        reportId: REPORT_ID as never,
        parentThreadId: PARENT_ID as never,
        childThreadId: CHILD_ID as never,
        agentSlug: "scribe",
        description: "Draft the chapter",
        result: REPORT_RESULT,
      });
    }

    async function parentTurns() {
      return db.select().from(schema.turns).where(eq(schema.turns.threadId, PARENT_ID));
    }

    it("commits the obligation in the same transaction as the terminal lifecycle", async () => {
      await expect(
        repos.transaction(async () => {
          await repos.threads.updateSpawnLifecycle(CHILD_ID as never, {
            spawnStatus: "succeeded",
            spawnResult: REPORT_RESULT,
          });
          await enqueueReport(composeDelivery().delivery);
          throw new Error("terminal rollback");
        }),
      ).rejects.toThrow("terminal rollback");

      const [rolledBackChild] = await db
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.id, CHILD_ID));
      expect(rolledBackChild?.spawnStatus).toBe("running");
      await expect(db.select().from(schema.childReportDeliveries)).resolves.toHaveLength(0);

      await repos.transaction(async () => {
        await repos.threads.updateSpawnLifecycle(CHILD_ID as never, {
          spawnStatus: "succeeded",
          spawnResult: REPORT_RESULT,
        });
        await enqueueReport(composeDelivery().delivery);
      });
      await expect(db.select().from(schema.childReportDeliveries)).resolves.toMatchObject([
        { reportId: REPORT_ID, parentThreadId: PARENT_ID, submissionEpoch: 0 },
      ]);
    });

    it("writes one deterministic card and admits one continuation for an idle parent", async () => {
      const seenMetadata: Array<unknown> = [];
      const { delivery } = composeDelivery(seenMetadata);
      await enqueueReport(delivery);

      await delivery.flush(PARENT_ID as never);

      const turns = await parentTurns();
      expect(turns.map((turn) => turn.role).sort()).toEqual(["assistant", "system", "user"]);
      const blocks = await db.select().from(schema.turnBlocks);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ id: REPORT_ID, blockType: "custom" });
      expect(blocks[0]?.content).toMatchObject({
        kind: "helper-result",
        props: { agentSlug: "scribe", childThreadId: CHILD_ID, status: "completed" },
      });

      const admissions = await db.select().from(schema.userTurnAdmissions);
      expect(admissions).toMatchObject([
        { submissionId: `child-report:${REPORT_ID}:0`, state: "accepted" },
      ]);
      expect(seenMetadata).toEqual([{ kind: "system_update", section: "child_report" }]);
      expect(CHILD_REPORT_CONTINUATION_TEXT).toBe(SUBMISSION_TEXT);
      await expect(db.select().from(schema.childReportDeliveries)).resolves.toHaveLength(0);
    });

    it("replays an already-accepted report without a second card or turn pair", async () => {
      const { delivery } = composeDelivery();
      await enqueueReport(delivery);
      await delivery.flush(PARENT_ID as never);
      const afterFirst = await parentTurns();

      await enqueueReport(delivery);
      await delivery.flush(PARENT_ID as never);

      expect(await parentTurns()).toHaveLength(afterFirst.length);
      await expect(db.select().from(schema.turnBlocks)).resolves.toHaveLength(1);
      await expect(db.select().from(schema.userTurnAdmissions)).resolves.toHaveLength(1);
      await expect(db.select().from(schema.childReportDeliveries)).resolves.toHaveLength(0);
    });

    it("advances the epoch after an expired pending attempt and admits exactly once", async () => {
      const { delivery } = composeDelivery();
      await enqueueReport(delivery);
      await records.reserve({
        threadId: PARENT_ID as never,
        submissionId: `child-report:${REPORT_ID}:0`,
        actorUserId: USER_ID as never,
        fingerprint: canonicalAdmissionFingerprint({
          actorUserId: USER_ID,
          threadId: PARENT_ID,
          text: SUBMISSION_TEXT,
          blocks: [{ type: "text", text: SUBMISSION_TEXT }],
          references: [],
          activatedSkillSlugs: [],
        }),
        claimExpiresAt: new Date(0),
      });

      await delivery.flush(PARENT_ID as never);

      const admissions = (await db.select().from(schema.userTurnAdmissions)).sort((a, b) =>
        a.submissionId.localeCompare(b.submissionId),
      );
      expect(admissions.map((row) => [row.submissionId, row.state])).toEqual([
        [`child-report:${REPORT_ID}:0`, "rejected"],
        [`child-report:${REPORT_ID}:1`, "accepted"],
      ]);
      expect(await parentTurns()).toHaveLength(3);
      await expect(db.select().from(schema.childReportDeliveries)).resolves.toHaveLength(0);
    });

    it("leaves the obligation pending while a live writer owns the run claim, then delivers", async () => {
      const { delivery, runOwnership } = composeDelivery();
      await enqueueReport(delivery);
      const writerClaim = await runOwnership.tryAcquire(PARENT_ID as never);
      expect(writerClaim).not.toBeNull();

      try {
        await delivery.flush(PARENT_ID as never);
        // The card write is refused, so no system turn or block is created.
        await expect(db.select().from(schema.childReportDeliveries)).resolves.toMatchObject([
          { reportId: REPORT_ID, submissionEpoch: 0, systemTurnId: null },
        ]);
        await expect(parentTurns()).resolves.toHaveLength(0);
        await expect(db.select().from(schema.turnBlocks)).resolves.toHaveLength(0);
      } finally {
        await writerClaim?.release();
      }

      await delivery.flush(PARENT_ID as never);
      await expect(db.select().from(schema.childReportDeliveries)).resolves.toHaveLength(0);
      expect(await parentTurns()).toHaveLength(3);
      await expect(db.select().from(schema.turnBlocks)).resolves.toHaveLength(1);
    });

    it("lands the card, then defers to a writer that takes the claim before admission", async () => {
      const runOwnership = createInMemoryThreadRunOwnership();
      const writer: { claim: { release(): Promise<void> } | null } = { claim: null };
      let writerWon = false;
      const realAdmission = createHostTurnAdmission({
        records,
        runOwnership,
        starter: acceptingStarter([]) as never,
      });
      const admission = {
        async lookup(request: Parameters<typeof realAdmission.lookup>[0]) {
          return realAdmission.lookup(request);
        },
        async admit(input: Parameters<typeof realAdmission.admit>[0]) {
          if (!writerWon) {
            // The writer acquires the claim after ensureCard released it and
            // before the delivery can admit.
            writerWon = true;
            writer.claim = await runOwnership.tryAcquire(input.threadId);
            return { kind: "pending" as const, submissionId: input.submissionId };
          }
          return realAdmission.admit(input);
        },
      };
      const delivery = createChildReportDelivery({
        repos,
        eventWriter: createDrizzleEventJournalWriter(db),
        admission: admission as never,
        isThreadRunning: () => false,
        runOwnership,
        schedulePostCommit: () => {},
      });
      await enqueueReport(delivery);

      await delivery.flush(PARENT_ID as never);

      // The card lands on the parent; the writer now owns the run claim.
      const blocks = await db.select().from(schema.turnBlocks);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ id: REPORT_ID, blockType: "custom" });
      await expect(db.select().from(schema.childReportDeliveries)).resolves.toMatchObject([
        { reportId: REPORT_ID, systemTurnId: expect.any(String) },
      ]);

      // A flush while the writer holds the claim does not append a second card.
      await delivery.flush(PARENT_ID as never);
      await expect(db.select().from(schema.turnBlocks)).resolves.toHaveLength(1);

      await writer.claim?.release();
      // With the writer gone the obligation delivers and disappears.
      await delivery.flush(PARENT_ID as never);
      await expect(db.select().from(schema.childReportDeliveries)).resolves.toHaveLength(0);
      await expect(db.select().from(schema.userTurnAdmissions)).resolves.toMatchObject([
        { submissionId: `child-report:${REPORT_ID}:0`, state: "accepted" },
      ]);
    });
  });
}
