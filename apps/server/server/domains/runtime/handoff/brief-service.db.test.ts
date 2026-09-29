/** PostgreSQL contract for an independent brief settling outside the source run. */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createDrizzleRunClaim } from "../adapters/drizzle-run-claim.js";
import { createDrizzleThreadLock } from "../adapters/drizzle-thread-lock.js";
import { processDetachedWork } from "../detached-work.js";
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
    const { createDetachedWorkTracker } = await import("../detached-work.js");
    const { createDrizzleCreditLedger } = await import("../../billing/index.js");
    const { createTestDrizzleDelivery } = await import(
      "../loop/__tests__/test-drizzle-delivery.js"
    );
    const { createRuntimeHarness } = await import("../loop/__tests__/runtime-harness.js");
    const { createTestAgentBinding } = await import("../loop/__tests__/runtime-fixtures.js");
    const { scriptedGateway } = await import("../loop/__tests__/test-gateway.js");
    const { createRunStarter } = await import("../loop/run-starter.js");
    const { generateHandoffBrief } = await import("./brief-request.js");
    const { createWakeIfRunnable } = await import("../loop/wake-if-runnable.js");
    const { createOrphanReportRepair } = await import("../spawn/orphan-report-repair.js");
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
        shutdown: { started: false },
        backgroundTasks: processDetachedWork,
        repos: options.repos ?? repos,
        eventWriter: createDrizzleEventJournalWriter(db),
        eventSink: createInMemoryEventSink(),
        threadLock: createDrizzleThreadLock(db),
        runClaim,
        prioritizePendingControls: (threadId) =>
          createDrizzleInbox(db).prioritizePendingControls(threadId),
        async wakeIfRunnable() {},
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
        schedulePostCommit(task) {
          void task();
        },
      });
    }

    async function startBrief(
      service: ReturnType<typeof createHandoffBriefs>,
      threadId: string,
      seedTurnId: string,
    ) {
      const claim = await service.hold(threadId as never);
      if (!claim) return false;
      service.launchAfterCommit({
        threadId: threadId as never,
        seedTurnId: seedTurnId as never,
        claim,
      });
      return true;
    }

    async function destinationRunner(
      fixture: Awaited<ReturnType<typeof handoffSeed>>,
      agentRevisions?: NonNullable<Parameters<typeof createRuntimeHarness>[0]>["agentRevisions"],
    ) {
      const backgroundTasks = createDetachedWorkTracker();
      const runClaim = createDrizzleRunClaim(db, { holderId: "brief-wake-runner" });
      const eventWriter = createDrizzleEventJournalWriter(db);
      const creditLedger = createDrizzleCreditLedger(db);
      await creditLedger.grant({
        userId: fixture.ids.user,
        source: "manual",
        amountMillicredits: "1000000000",
        reason: "brief wake runtime fixture",
      });
      let runtime!: ReturnType<typeof createRuntimeHarness>;
      const runStarter = createRunStarter(
        { startDrain: (threadId) => runtime.startDrain(threadId) },
        createInMemoryEventSink(),
      );
      const delivery = createTestDrizzleDelivery(db, {
        backgroundTasks,
        repos: fixture.repos,
        eventWriter,
        runClaim,
        runStarter,
      });
      runtime = createRuntimeHarness({
        backgroundTasks,
        repos: fixture.repos,
        eventWriter,
        runClaim,
        delivery,
        runStarter,
        creditLedger,
        agentRevisions:
          agentRevisions ??
          createTestAgentBinding("gpt-4.1-mini", "Write stories.", () => [fixture.destination.id]),
        gateway: scriptedGateway({ usage: { inputTokens: 1, outputTokens: 1 } }),
      });
      return { backgroundTasks, delivery, runClaim, runStarter, runtime };
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
      expect(await inbox.pendingMessageThreads(10)).toEqual([destination.id]);
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
      expect(await repos.turns.listPendingPlaceholdersForThread(destination.id)).toContainEqual(
        expect.objectContaining({ id: seed.id, role: "system", status: "pending" }),
      );
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
        shutdown: { started: false },
        backgroundTasks: processDetachedWork,
        repos,
        eventWriter,
        eventSink: createInMemoryEventSink(),
        threadLock: createDrizzleThreadLock(db),
        runClaim,
        prioritizePendingControls: (threadId) =>
          createDrizzleInbox(db).prioritizePendingControls(threadId),
        async wakeIfRunnable(threadId) {
          if (threadId === destination.id) wakes += 1;
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

      const briefClaim = required(await service.hold(destination.id));
      service.launchAfterCommit({
        threadId: destination.id,
        seedTurnId: seed.id,
        claim: briefClaim,
      });
      await required(postCommit.shift())();
      await expect.poll(async () => (await repos.turns.findById(seed.id))?.status).toBe("complete");
      await Promise.all(postCommit.splice(0).map((task) => task()));

      expect(await repos.turns.findById(seed.id)).toMatchObject({ status: "complete" });
      expect(await repos.turns.listPendingPlaceholdersForThread(destination.id)).toEqual([]);
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

    it.each([
      "complete",
      "failed",
      "stopped",
    ] as const)("answers a held-claim message after a %s handoff seed using the real run starter", async (ending) => {
      const fixture = await handoffSeed();
      const runner = await destinationRunner(fixture);
      const { backgroundTasks, delivery, runClaim, runStarter } = runner;
      const wakeIfRunnable = createWakeIfRunnable({ delivery, runStarter });
      let markProviderStarted!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        markProviderStarted = resolve;
      });
      let releaseProvider!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const postCommit: Array<() => Promise<void>> = [];
      const service = createHandoffBriefs({
        shutdown: { started: false },
        backgroundTasks,
        repos: fixture.repos,
        eventWriter: createDrizzleEventJournalWriter(db),
        eventSink: createInMemoryEventSink(),
        threadLock: createDrizzleThreadLock(db),
        runClaim,
        prioritizePendingControls: (threadId) =>
          createDrizzleInbox(db).prioritizePendingControls(threadId),
        wakeIfRunnable,
        billingUsage: {
          async canStartTurn() {
            return true;
          },
        },
        async generate({ signal }) {
          markProviderStarted();
          if (ending === "stopped")
            return new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => resolve({ outcome: { kind: "cancelled", modelResponses: [] } }),
                { once: true },
              );
            });
          await providerGate;
          if (ending === "failed") throw new Error("brief provider failure");
          return {
            outcome: {
              kind: "complete",
              text: "Brief ready.",
              model: "test-model",
              modelResponses: [],
              summarizer: { path: "branch", segments: 1 },
            },
          };
        },
        async publishStatus() {},
        schedulePostCommit(task) {
          postCommit.push(task);
        },
      });
      const claim = required(await service.hold(fixture.destination.id));
      service.launchAfterCommit({
        threadId: fixture.destination.id,
        seedTurnId: fixture.seed.id,
        claim,
      });

      const launchPostCommit = required(postCommit.shift());
      await launchPostCommit();
      await providerStarted;
      expect(await runClaim.startExecution(fixture.destination.id, "racing-run")).toBeNull();
      const queued = await delivery.enqueue({
        threadId: fixture.destination.id,
        intent: "message",
        provenance: { kind: "writer", actorId: fixture.ids.user },
        body: { kind: "text", text: "After the brief." },
        idempotencyKey: "during-brief",
      });
      const compact =
        ending === "stopped"
          ? null
          : await delivery.enqueue({
              threadId: fixture.destination.id,
              intent: "control",
              provenance: { kind: "writer", actorId: fixture.ids.user },
              body: { kind: "compact" },
              idempotencyKey: "compact-during-brief",
            });
      expect(await runClaim.startExecution(fixture.destination.id, "racing-wake")).toBeNull();

      if (ending === "stopped") {
        await expect(service.stop(fixture.destination.id, fixture.seed.id)).resolves.toBe(true);
      } else {
        releaseProvider();
      }

      const expectedSeedStatus =
        ending === "complete" ? "complete" : ending === "failed" ? "error" : "cancelled";
      await expect
        .poll(async () => (await fixture.repos.turns.findById(fixture.seed.id))?.status)
        .toBe(expectedSeedStatus);
      await expect
        .poll(async () => (await fixture.repos.turns.findById(queued.id))?.status)
        .toBe("complete");
      await backgroundTasks.drain();

      const turns = await fixture.repos.turns.listByThread(fixture.destination.id);
      const answer = turns.find(
        (turn) => turn.role === "assistant" && turn.prevTurnId === queued.id,
      );
      expect(answer).toMatchObject({ status: "complete", prevTurnId: queued.id });
      expect(answer?.position).toBeGreaterThan(
        (await fixture.repos.turns.findById(fixture.seed.id))?.position ?? 0,
      );
      if (compact) {
        const compactTurn = await fixture.repos.turns.findByControlId(
          fixture.destination.id,
          compact.id,
        );
        expect(compactTurn?.position).toBeGreaterThan(
          (await fixture.repos.turns.findById(fixture.seed.id))?.position ?? 0,
        );
      }
      expect(await delivery.selectPending(fixture.destination.id)).toEqual([]);
    });

    it("completes the brief before a broken destination binding fails its reply", async () => {
      const fixture = await handoffSeed();
      const runner = await destinationRunner(
        fixture,
        createTestAgentBinding("gpt-4.1-mini", "Source Agent.", () => [fixture.source.id]),
      );
      let generateCalls = 0;
      const service = createHandoffBriefs({
        shutdown: { started: false },
        backgroundTasks: runner.backgroundTasks,
        repos: fixture.repos,
        eventWriter: createDrizzleEventJournalWriter(db),
        eventSink: createInMemoryEventSink(),
        threadLock: createDrizzleThreadLock(db),
        runClaim: runner.runClaim,
        prioritizePendingControls: (threadId) =>
          createDrizzleInbox(db).prioritizePendingControls(threadId),
        wakeIfRunnable: createWakeIfRunnable({
          delivery: runner.delivery,
          runStarter: runner.runStarter,
        }),
        billingUsage: {
          async canStartTurn() {
            return true;
          },
        },
        generate(input) {
          generateCalls += 1;
          return generateHandoffBrief(
            runner.runtime.deps,
            input.destination,
            input.seed,
            input.signal,
          );
        },
        async publishStatus() {},
        schedulePostCommit(task) {
          void task();
        },
      });
      const claim = required(await service.hold(fixture.destination.id));
      service.launchAfterCommit({
        threadId: fixture.destination.id,
        seedTurnId: fixture.seed.id,
        claim,
      });
      const queued = await runner.delivery.enqueue({
        threadId: fixture.destination.id,
        intent: "message",
        provenance: { kind: "writer", actorId: fixture.ids.user },
        body: { kind: "text", text: "The destination reply should fail." },
        idempotencyKey: "broken-destination-binding",
      });

      await expect
        .poll(async () => (await fixture.repos.turns.findById(fixture.seed.id))?.status)
        .toBe("complete");
      await expect
        .poll(async () =>
          (await fixture.repos.turns.listByThread(fixture.destination.id)).some(
            (turn) => turn.role === "assistant" && turn.status === "error",
          ),
        )
        .toBe(true);
      await runner.backgroundTasks.drain();

      expect(
        await runner.runtime.deps.agentRevisions.readThreadBinding(fixture.destination.id),
      ).toBeUndefined();
      expect(await fixture.repos.turns.findById(queued.id)).toMatchObject({
        role: "user",
        status: "complete",
      });
      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        role: "system",
        status: "complete",
      });
      expect(generateCalls).toBe(1);
    });

    it("settles paid rows on shutdown, leaves S pending, releases the claim, and skips the wake", async () => {
      const fixture = await handoffSeed();
      const runClaim = createDrizzleRunClaim(db, { holderId: "shutdown-brief" });
      const inbox = createDrizzleInbox(db);
      let startAttempts = 0;
      let startedRuns = 0;
      const runStarter = {
        async start(threadId: string) {
          startAttempts += 1;
          const lease = await runClaim.startExecution(
            threadId as never,
            `shutdown-wake-${startAttempts}`,
          );
          if (!lease) return;
          startedRuns += 1;
          await runClaim.release(lease);
        },
      };
      const delivery = createTestDrizzleDelivery(db, {
        repos: fixture.repos,
        runClaim,
        runStarter,
      });
      const wakeIfRunnable = createWakeIfRunnable({ delivery, runStarter });
      const queued = await inbox.enqueue({
        threadId: fixture.destination.id,
        intent: "message",
        provenance: { kind: "writer", actorId: fixture.ids.user },
        body: { kind: "text", text: "Wait behind shutdown." },
        idempotencyKey: "shutdown-brief-wake",
      });
      const responseId = crypto.randomUUID();
      const response = {
        id: responseId,
        turnId: fixture.seed.id,
        sequence: 0,
        provider: "openai",
        model: "gpt-4.1-mini",
        inputTokens: 1_000,
        outputTokens: 10,
        requestMessageCount: 1,
        predictedCacheState: "cold" as const,
        predictedCacheReason: "summary_transcript" as const,
      };
      let debitCount = 0;
      const billingUsage = {
        async canStartTurn() {
          return true;
        },
        async debit() {
          debitCount += 1;
          return { transactionId: crypto.randomUUID() };
        },
      };
      let markProviderStarted!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        markProviderStarted = resolve;
      });
      let providerSignal: AbortSignal | undefined;
      const postCommit: Array<() => Promise<void>> = [];
      const service = createHandoffBriefs({
        shutdown: { started: false },
        backgroundTasks: processDetachedWork,
        repos: fixture.repos,
        eventWriter: createDrizzleEventJournalWriter(db),
        eventSink: createInMemoryEventSink(),
        threadLock: createDrizzleThreadLock(db),
        runClaim,
        prioritizePendingControls: (threadId) =>
          createDrizzleInbox(db).prioritizePendingControls(threadId),
        wakeIfRunnable,
        billingUsage,
        async generate({ signal }) {
          providerSignal = signal;
          markProviderStarted();
          return new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () =>
                resolve({
                  outcome: {
                    kind: "cancelled",
                    modelResponses: [response],
                    summarizer: { path: "rolling", segments: 1 },
                  },
                }),
              { once: true },
            );
          });
        },
        async publishStatus() {},
        schedulePostCommit(task) {
          postCommit.push(task);
        },
      });
      const claim = required(await service.hold(fixture.destination.id));
      service.launchAfterCommit({
        threadId: fixture.destination.id,
        seedTurnId: fixture.seed.id,
        claim,
      });
      await required(postCommit.shift())();
      await providerStarted;

      await wakeIfRunnable(fixture.destination.id);
      expect(await inbox.selectPending(fixture.destination.id)).toMatchObject([{ id: queued.id }]);
      expect(startAttempts).toBe(1);
      expect(startedRuns).toBe(0);

      service.beginShutdown();
      await processDetachedWork.drain();

      expect(providerSignal?.reason).toBe("shutdown");
      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        status: "pending",
      });
      expect(await fixture.repos.modelResponses.listByTurn(fixture.seed.id)).toMatchObject([
        { id: responseId },
      ]);
      expect(debitCount).toBe(1);
      expect(startAttempts).toBe(1);
      expect(startedRuns).toBe(0);
      const reacquired = await runClaim.hold(fixture.destination.id);
      expect(reacquired).not.toBeNull();
      await reacquired?.release();
    });

    it("gates Retry on the live destination run and appends idempotently after Stop", async () => {
      const fixture = await handoffSeed();
      const runClaim = createDrizzleRunClaim(db, { holderId: "retry-run" });
      let markProviderStarted!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        markProviderStarted = resolve;
      });
      let releaseProvider!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const service = serviceFor(fixture.repos, runClaim, {
        async generate() {
          markProviderStarted();
          await providerGate;
          return {
            outcome: {
              kind: "complete",
              text: "Retry brief.",
              model: "test-model",
              modelResponses: [],
              summarizer: { path: "branch", segments: 1 },
            },
          };
        },
      });
      const retryId = crypto.randomUUID();

      const heldBrief = required(await service.hold(fixture.destination.id));
      await expect(
        service.retry({ threadId: fixture.destination.id, seedId: retryId }),
      ).rejects.toMatchObject({
        code: "handoff_retry_unavailable",
      });
      await heldBrief.release();
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
        },
      });
      await providerStarted;
      const replay = await service.retry({ threadId: fixture.destination.id, seedId: retryId });
      expect(replay).toMatchObject({ created: false, turn: { id: retried.turn.id } });
      releaseProvider();
      await expect
        .poll(async () => (await fixture.repos.turns.findById(retryId))?.status)
        .toBe("complete");
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

      expect(await startBrief(service, fixture.destination.id, fixture.seed.id)).toBe(true);
      await expect
        .poll(async () => (await fixture.repos.turns.findById(fixture.seed.id))?.status)
        .toBe("error");
      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        status: "error",
        metadata: { reason: "credits_exhausted", phase: "launch" },
      });
      expect(await fixture.repos.turns.findById(fixture.seed.id)).not.toHaveProperty(
        "metadata.summarizer",
      );
    });

    it("does not record a summary path when generation throws before a response", async () => {
      const fixture = await handoffSeed();
      const runClaim = createDrizzleRunClaim(db, { holderId: "brief-generator-throw" });
      const service = serviceFor(fixture.repos, runClaim, {
        async generate() {
          throw new Error("pre-summary generator failure");
        },
      });

      expect(await startBrief(service, fixture.destination.id, fixture.seed.id)).toBe(true);
      await expect
        .poll(async () => (await fixture.repos.turns.findById(fixture.seed.id))?.status)
        .toBe("error");

      expect(await fixture.repos.turns.findById(fixture.seed.id)).not.toHaveProperty(
        "metadata.summarizer",
      );
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

      expect(await startBrief(first, fixture.destination.id, fixture.seed.id)).toBe(true);
      await providerStarted;
      const secondRunClaim = createDrizzleRunClaim(db, { holderId: "multi-worker-second" });
      const secondWithOwnClaim = serviceFor(fixture.repos, secondRunClaim, { generate });
      expect(await startBrief(secondWithOwnClaim, fixture.destination.id, fixture.seed.id)).toBe(
        false,
      );
      expect(providerCalls).toBe(1);
      release();
      await expect
        .poll(async () => (await fixture.repos.turns.findById(fixture.seed.id))?.status)
        .toBe("complete");

      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        status: "complete",
      });
    });

    it("keeps Stop's terminal block when a late provider result arrives", async () => {
      const fixture = await handoffSeed();
      const runClaim = createDrizzleRunClaim(db, { holderId: "stop-race" });
      const inbox = createDrizzleInbox(db);
      const compact = await inbox.enqueue({
        threadId: fixture.destination.id,
        intent: "control",
        provenance: { kind: "writer", actorId: fixture.ids.user },
        body: { kind: "compact" },
        idempotencyKey: "compact-before-brief-stop",
      });
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

      expect(await startBrief(service, fixture.destination.id, fixture.seed.id)).toBe(true);
      await providerStarted;
      expect(await service.stop(fixture.destination.id, fixture.seed.id)).toBe(true);
      expect(await inbox.findMessage(compact.id)).toMatchObject({ runsFirst: true });
      release();
      await expect
        .poll(async () => (await fixture.repos.turns.findById(fixture.seed.id))?.status)
        .toBe("cancelled");

      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        status: "cancelled",
      });
      expect(await fixture.repos.blocks.listByTurn(fixture.seed.id)).toMatchObject([
        { content: { kind: "handoff-brief", props: { state: "unavailable" } } },
      ]);
    });

    it("leaves a pending seed for repair after its ending transaction fails", async () => {
      const fixture = await handoffSeed();
      const runClaim = createDrizzleRunClaim(db, { holderId: "settlement-failure" });
      let transactionCalls = 0;
      const flakyRepos = {
        ...fixture.repos,
        async transaction<T>(_operation: () => Promise<T>): Promise<T> {
          transactionCalls += 1;
          throw new Error("ending commit failure");
        },
      };
      const service = serviceFor(fixture.repos, runClaim, { repos: flakyRepos });

      expect(await startBrief(service, fixture.destination.id, fixture.seed.id)).toBe(true);
      await expect.poll(async () => transactionCalls).toBe(1);
      await expect
        .poll(async () => {
          const freeClaim = await runClaim.hold(fixture.destination.id);
          if (!freeClaim) return false;
          await freeClaim.release();
          return true;
        })
        .toBe(true);

      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        status: "pending",
      });
      expect(await fixture.repos.blocks.listByTurn(fixture.seed.id)).toHaveLength(0);
    });

    it("repairs a crashed handoff seed through the guarded placeholder sweep", async () => {
      const fixture = await handoffSeed();
      const authority = createDrizzleRunClaim(db, { holderId: "handoff-placeholder-sweep" });
      let statusPublishes = 0;
      const repair = createOrphanReportRepair({
        repos: fixture.repos,
        inbox: createDrizzleInbox(db),
        eventWriter: createDrizzleEventJournalWriter(db),
        authority,
        threadLock: createDrizzleThreadLock(db),
        publisher: {
          async publish() {
            return "already" as const;
          },
        },
        eventSink: createInMemoryEventSink(),
        toolRegistry: {
          getRegistration(name: string) {
            return name === "thread_history" ? ({} as never) : undefined;
          },
        },
        async publishStatus(threadId: string) {
          expect(threadId).toBe(fixture.destination.id);
          statusPublishes += 1;
        },
      });
      const liveClaim = required(await authority.hold(fixture.destination.id));
      await repair.sweep(10);
      expect(await fixture.repos.turns.findById(fixture.seed.id)).toMatchObject({
        status: "pending",
      });
      expect(statusPublishes).toBe(0);

      await liveClaim.release();
      await repair.sweep(10);
      const seed = await fixture.repos.turns.findById(fixture.seed.id);

      expect(seed).toMatchObject({
        role: "system",
        status: "error",
        error: "This handoff brief couldn't be generated. Try again.",
        metadata: { reason: "interrupted", phase: "recovery" },
      });
      const [card] = await fixture.repos.blocks.listByTurn(fixture.seed.id);
      expect(card?.content).toMatchObject({
        kind: "handoff-brief",
        props: { state: "unavailable" },
      });
      expect(card?.content).toHaveProperty(
        "props.modelText",
        expect.stringContaining(`<thread_reference ref="${fixture.source.ref}">`),
      );
      expect(statusPublishes).toBe(1);
    });
  });
