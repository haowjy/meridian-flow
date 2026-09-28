/** PostgreSQL contract for an independent brief settling outside the source run. */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createDrizzleHandoffBriefClaim } from "../adapters/drizzle-handoff-brief-claim.js";
import { createDrizzleRunClaim } from "../adapters/drizzle-run-claim.js";
import { createDrizzleThreadLock } from "../adapters/drizzle-thread-lock.js";
import { createHandoffBriefs } from "./brief-service.js";

const url = process.env.DATABASE_URL;
const run = !!url && ["1", "true"].includes(process.env.RUN_DB_TESTS ?? "");

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected a value");
  return value;
}

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
    const { createDrizzleInbox } = await import("../adapters/drizzle-inbox.js");
    const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
    const { handoffSeedMetadata } = await import("../../threads/index.js");
    const databaseUrl = required(url);
    assertThrowawayDatabaseForRunDbTests(databaseUrl);
    const db = createDb(databaseUrl, { max: 8 });
    beforeEach(() => deleteDrizzleRows(db, [schema.users]));
    afterAll(() => db.close());

    async function handoffSeed() {
      const { ids, repos } = await executionScenario(db);
      const source = required(await repos.threads.findById(ids.caller));
      const cutoff = required(await repos.turns.findById(ids.callerTurn));
      const { thread: destination } = await repos.threads.createDerivedPrimary({
        id: crypto.randomUUID() as never,
        userId: ids.user,
        projectId: ids.project,
        workId: null,
        source,
        originType: "handoff",
        originTurnId: cutoff.id,
        title: "Handoff destination",
      });
      const seed = await repos.turns.create({
        threadId: destination.id,
        role: "system",
        origin: "system",
        status: "pending",
        metadata: handoffSeedMetadata({
          sourceThreadId: source.id,
          sourceRef: required(source.ref),
          sourceTitle: source.title,
          cutoffTurnId: cutoff.id,
        }),
      });
      return { ids, repos, source, cutoff, destination, seed };
    }

    function serviceFor(
      repos: Awaited<ReturnType<typeof executionScenario>>["repos"],
      runClaim: ReturnType<typeof createDrizzleRunClaim>,
      options: {
        canStartTurn?: () => Promise<boolean>;
        generate?: Parameters<typeof createHandoffBriefs>[0]["generate"];
        repos?: Parameters<typeof createHandoffBriefs>[0]["repos"];
      } = {},
    ) {
      return createHandoffBriefs({
        repos: options.repos ?? repos,
        eventWriter: createDrizzleEventJournalWriter(db),
        eventSink: createInMemoryEventSink(),
        threadLock: createDrizzleThreadLock(db),
        claim: createDrizzleHandoffBriefClaim(db),
        runClaim,
        runStarter: { async start() {} },
        billingUsage: { canStartTurn: options.canStartTurn ?? (async () => true) },
        generate:
          options.generate ??
          (async () => ({
            outcome: {
              kind: "complete",
              text: "A completed handoff brief.",
              model: "test-model",
              modelResponses: [],
              summarizer: { path: "branch", segments: 1 },
            },
          })),
        async publishStatus() {},
        schedulePostCommit() {},
      });
    }

    it("settles a pending seed without acquiring or mutating the source run", async () => {
      const { ids, repos } = await executionScenario(db);
      const source = required(await repos.threads.findById(ids.caller));
      const cutoff = required(await repos.turns.findById(ids.callerTurn));
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
          sourceRef: required(source.ref),
          sourceTitle: source.title,
          cutoffTurnId: cutoff.id,
        }),
      });
      const runClaim = createDrizzleRunClaim(db, { holderId: "source-run" });
      const inbox = createDrizzleInbox(db);
      const queued = await inbox.enqueue({
        threadId: destination.id,
        intent: "message",
        provenance: { kind: "writer", actorId: ids.user },
        body: { kind: "text", text: "Wait for the handoff brief." },
        idempotencyKey: "queued-during-brief",
      });
      expect(await inbox.pendingMessageThreads(10)).toEqual([]);
      const sourceLease = await runClaim.startExecution(source.id, "source-running");
      const heldSourceLease = required(sourceLease);
      const sourceTurnsBefore = await repos.turns.listByThread(source.id);
      const sourceInboxBefore = await db
        .select()
        .from(schema.threadInboxMessages)
        .where(eq(schema.threadInboxMessages.threadId, source.id));
      const eventWriter = createDrizzleEventJournalWriter(db);
      const statusReader = (
        await import("../adapters/drizzle-handoff-status-reader.js")
      ).createDrizzleHandoffStatusReader(db, runClaim);
      expect(await repos.turns.hasPendingHandoffSeed(destination.id)).toBe(true);
      expect(await statusReader.read(destination.id)).toMatchObject({
        kind: "awake",
        phase: "generating",
      });
      expect(await statusReader.readRunningTurnId(destination.id)).toBeNull();
      expect(await runClaim.holder(destination.id)).toBeNull();

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
        runStarter: {
          async start(threadId) {
            if (threadId === destination.id) wakes += 1;
          },
        },
        billingUsage: {
          async canStartTurn() {
            return true;
          },
        },
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
        schedulePostCommit(task) {
          postCommit.push(task);
        },
      });

      expect(await service.sweep()).toBe(1);
      await Promise.all(postCommit.splice(0).map((task) => task()));

      expect(await repos.turns.findById(seed.id)).toMatchObject({ status: "complete" });
      expect(await repos.turns.hasPendingHandoffSeed(destination.id)).toBe(false);
      expect(await repos.blocks.listByTurn(seed.id)).toHaveLength(1);
      expect(await statusReader.read(destination.id)).toEqual({ kind: "asleep" });
      expect(await runClaim.holder(destination.id)).toBeNull();
      expect(await inbox.selectPending(destination.id)).toMatchObject([{ id: queued.id }]);
      expect(await inbox.pendingMessageThreads(10)).toEqual([destination.id]);
      expect(wakes).toBe(1);
      expect(published).toHaveLength(2);
      expect(await service.stop(destination.id, seed.id)).toBe(false);
      expect(await runClaim.read(source.id)).toMatchObject({ kind: "awake" });
      expect(await repos.turns.listByThread(source.id)).toEqual(sourceTurnsBefore);
      expect(
        await db
          .select()
          .from(schema.threadInboxMessages)
          .where(eq(schema.threadInboxMessages.threadId, source.id)),
      ).toEqual(sourceInboxBefore);
      await runClaim.release(heldSourceLease);
    });

    it("gates Retry on the live destination run and appends idempotently after Stop", async () => {
      const fixture = await handoffSeed();
      const runClaim = createDrizzleRunClaim(db, { holderId: "retry-run" });
      const service = serviceFor(fixture.repos, runClaim);
      const retryId = crypto.randomUUID();

      await expect(
        service.retry({ threadId: fixture.destination.id, seedId: retryId }),
      ).rejects.toMatchObject({
        code: "handoff_retry_unavailable",
      });
      expect(await service.stop(fixture.destination.id, fixture.seed.id)).toBe(true);
      const liveReply = await runClaim.startExecution(fixture.destination.id, "destination-reply");
      const heldLiveReply = required(liveReply);
      await expect(
        service.retry({ threadId: fixture.destination.id, seedId: retryId }),
      ).rejects.toMatchObject({
        code: "handoff_retry_unavailable",
      });
      await runClaim.release(heldLiveReply);

      const retried = await service.retry({ threadId: fixture.destination.id, seedId: retryId });
      expect(retried.created).toBe(true);
      expect(retried.turn).toMatchObject({
        id: retryId,
        status: "pending",
        prevTurnId: fixture.seed.id,
        metadata: {
          sourceThreadId: fixture.source.id,
          sourceRef: fixture.source.ref,
          sourceTitle: fixture.source.title,
          cutoffTurnId: fixture.cutoff.id,
          launches: 0,
        },
      });
      await expect(
        service.retry({ threadId: fixture.destination.id, seedId: retryId }),
      ).resolves.toEqual({
        turn: retried.turn,
        created: false,
      });
      await expect(
        service.retry({ threadId: fixture.destination.id, seedId: fixture.cutoff.id }),
      ).rejects.toMatchObject({ code: "seed_id_conflict" });
    });

    it("settles a zero-credit seed at launch without calling the summarizer", async () => {
      const fixture = await handoffSeed();
      const runClaim = createDrizzleRunClaim(db, { holderId: "credit-gate" });
      const generate = async () => {
        throw new Error("must not call the summarizer");
      };
      const service = serviceFor(fixture.repos, runClaim, {
        async canStartTurn() {
          return false;
        },
        generate,
      });

      await service.launch(fixture.seed.id);

      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        status: "error",
        metadata: { launches: 1, reason: "credits_exhausted", phase: "launch" },
      });
    });

    it("runs one provider call when two service instances claim the same seed", async () => {
      const fixture = await handoffSeed();
      const runClaim = createDrizzleRunClaim(db, { holderId: "multi-worker" });
      let started!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let providerCalls = 0;
      const generate = async () => {
        providerCalls += 1;
        started();
        await providerGate;
        return {
          outcome: {
            kind: "complete" as const,
            text: "One claimed result.",
            model: "test-model",
            modelResponses: [],
            summarizer: { path: "branch" as const, segments: 1 },
          },
        };
      };
      const first = serviceFor(fixture.repos, runClaim, { generate });
      const second = serviceFor(fixture.repos, runClaim, { generate });

      const launching = first.launch(fixture.seed.id);
      await providerStarted;
      await second.launch(fixture.seed.id);
      expect(providerCalls).toBe(1);
      release();
      await launching;

      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        status: "complete",
      });
    });

    it("keeps Stop's terminal block when a late provider result arrives", async () => {
      const fixture = await handoffSeed();
      const runClaim = createDrizzleRunClaim(db, { holderId: "stop-race" });
      let started!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const service = serviceFor(fixture.repos, runClaim, {
        async generate() {
          started();
          await providerGate;
          return {
            outcome: {
              kind: "complete",
              text: "Late provider result.",
              model: "test-model",
              modelResponses: [],
              summarizer: { path: "branch", segments: 1 },
            },
          };
        },
      });

      const launching = service.launch(fixture.seed.id);
      await providerStarted;
      expect(await service.stop(fixture.destination.id, fixture.seed.id)).toBe(true);
      release();
      await launching;

      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        status: "cancelled",
      });
      expect(await fixture.repos.blocks.listByTurn(fixture.seed.id)).toMatchObject([
        { content: { kind: "handoff-brief", props: { state: "unavailable" } } },
      ]);
    });

    it("retries the same good outcome after one settlement transaction failure", async () => {
      const fixture = await handoffSeed();
      const runClaim = createDrizzleRunClaim(db, { holderId: "settlement-retry" });
      let transactionCalls = 0;
      const flakyRepos = {
        ...fixture.repos,
        async transaction<T>(operation: () => Promise<T>): Promise<T> {
          transactionCalls += 1;
          if (transactionCalls === 1) throw new Error("temporary commit failure");
          return fixture.repos.transaction(operation);
        },
      };
      const service = serviceFor(fixture.repos, runClaim, { repos: flakyRepos });

      await service.launch(fixture.seed.id);

      expect(transactionCalls).toBeGreaterThan(1);
      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        status: "complete",
      });
      expect(await fixture.repos.blocks.listByTurn(fixture.seed.id)).toHaveLength(1);
    });
  });
