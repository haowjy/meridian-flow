/** Pure service contracts for handoff claims and non-Stop aborts. */
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "../../threads/adapters/in-memory/repositories.js";
import { handoffSeedMetadata } from "../../threads/index.js";
import { processDetachedWork } from "../detached-work.js";
import { createRuntimeHarness, runtimeScenario } from "../loop/__tests__/runtime-harness.js";
import { scriptedGateway } from "../loop/__tests__/test-gateway.js";
import { createRunStarter } from "../loop/run-starter.js";
import { createWakeIfRunnable } from "../loop/wake-if-runnable.js";
import { createHandoffBriefs } from "./brief-service.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected a value");
  return value;
}

async function createFixture() {
  const rig = createRuntimeHarness({ repos: createInMemoryRepositories() });
  const source = await rig.repos.threads.create({ userId: "writer", projectId: "project" });
  const cutoff = await rig.repos.turns.create({
    threadId: source.id,
    role: "user",
    origin: "writer",
    status: "complete",
  });
  const destination = await rig.repos.threads.create({
    userId: source.userId,
    projectId: source.projectId,
  });
  const seed = await rig.repos.turns.create({
    threadId: destination.id,
    role: "system",
    origin: "system",
    status: "pending",
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: source.id,
      sourceRef: required(source.ref),
      sourceTitle: source.title,
      cutoffTurnId: cutoff.id,
    },
  });
  return { rig, source, destination, seed };
}

describe("handoff brief service", () => {
  it("leaves S pending after losing the claim and wakes only after release", async () => {
    const state = await createFixture();
    const listeners = new Set<() => void>();
    let released!: () => void;
    const releaseFinished = new Promise<void>((resolve) => {
      released = resolve;
    });
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wakes: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const service = createHandoffBriefs({
      repos: state.rig.repos,
      eventWriter: state.rig.eventWriter,
      eventSink: state.rig.deps.eventSink,
      threadLock: {
        async withThreadLock(_threadId, operation) {
          return operation();
        },
      },
      runClaim: {
        async hold() {
          return {
            onLost(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            async release() {
              released();
            },
          };
        },
      },
      async wakeIfRunnable(threadId) {
        wakes.push(threadId);
      },
      billingUsage: state.rig.deps.billingUsage,
      async generate({ signal }) {
        started();
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                outcome: {
                  kind: "cancelled",
                  modelResponses: [],
                  summarizer: { path: "rolling", segments: 0 },
                },
              }),
            { once: true },
          );
        });
      },
      async publishStatus() {},
      schedulePostCommit(task) {
        scheduled.push(task);
      },
    });

    const claim = required(await service.hold(state.destination.id));
    service.launchAfterCommit({
      threadId: state.destination.id,
      seedTurnId: state.seed.id,
      claim,
    });
    await required(scheduled.shift())();
    await providerStarted;
    for (const listener of listeners) listener();
    await releaseFinished;

    expect(await state.rig.repos.turns.findById(state.seed.id)).toMatchObject({
      status: "pending",
    });
    expect(
      await state.rig.repos.turns.listPendingPlaceholdersForThread(state.destination.id),
    ).toEqual([expect.objectContaining({ id: state.seed.id, role: "system", status: "pending" })]);
    expect(wakes).toEqual([state.destination.id]);
  });

  it("aborts live briefs on process shutdown without settling S as cancelled", async () => {
    const state = await createFixture();
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let providerSignal!: AbortSignal;
    let released!: () => void;
    const releaseFinished = new Promise<void>((resolve) => {
      released = resolve;
    });
    const scheduled: Array<() => Promise<void>> = [];
    const service = createHandoffBriefs({
      repos: state.rig.repos,
      eventWriter: state.rig.eventWriter,
      eventSink: state.rig.deps.eventSink,
      threadLock: {
        async withThreadLock(_threadId, operation) {
          return operation();
        },
      },
      runClaim: {
        async hold() {
          return {
            onLost() {
              return () => undefined;
            },
            async release() {
              released();
            },
          };
        },
      },
      async wakeIfRunnable() {},
      billingUsage: state.rig.deps.billingUsage,
      async generate({ signal }) {
        providerSignal = signal;
        started();
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                outcome: {
                  kind: "cancelled",
                  modelResponses: [],
                  summarizer: { path: "rolling", segments: 0 },
                },
              }),
            { once: true },
          );
        });
      },
      async publishStatus() {},
      schedulePostCommit(task) {
        scheduled.push(task);
      },
    });
    const claim = required(await service.hold(state.destination.id));
    service.launchAfterCommit({ threadId: state.destination.id, seedTurnId: state.seed.id, claim });
    await required(scheduled.shift())();
    await providerStarted;
    service.beginShutdown();
    await processDetachedWork.drain();
    await releaseFinished;

    expect(providerSignal.reason).toBe("shutdown");
    expect(await state.rig.repos.turns.findById(state.seed.id)).toMatchObject({
      status: "pending",
    });
  });

  it("re-reads the queue when Retry releases without launching", async () => {
    const rig = await runtimeScenario({
      gateway: scriptedGateway({ usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    let markRetryHeld!: () => void;
    const retryHeld = new Promise<void>((resolve) => {
      markRetryHeld = resolve;
    });
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const service = createHandoffBriefs({
      repos: rig.repos,
      eventWriter: rig.eventWriter,
      eventSink: rig.deps.eventSink,
      threadLock: {
        async withThreadLock(_threadId, operation) {
          markRetryHeld();
          await retryGate;
          return operation();
        },
      },
      runClaim: rig.runClaim,
      wakeIfRunnable: createWakeIfRunnable({
        delivery: rig.delivery,
        runStarter: createRunStarter(rig.runner, rig.deps.eventSink),
      }),
      billingUsage: rig.deps.billingUsage,
      async generate() {
        throw new Error("Retry must not launch a brief for a non-handoff thread");
      },
      async publishStatus() {},
      schedulePostCommit(task) {
        void task();
      },
    });
    const retry = service.retry({
      threadId: rig.thread.id,
      seedId: crypto.randomUUID() as never,
    });
    await retryHeld;
    const queued = await rig.inbox.enqueue({
      threadId: rig.thread.id,
      intent: "message",
      provenance: { kind: "writer", actorId: rig.userId },
      body: { kind: "text", text: "Answer after Retry releases." },
      idempotencyKey: "retry-release-wake",
    });
    const wakeIfRunnable = createWakeIfRunnable({
      delivery: rig.delivery,
      runStarter: createRunStarter(rig.runner, rig.deps.eventSink),
    });
    await wakeIfRunnable(rig.thread.id);
    expect(await rig.inbox.selectPending(rig.thread.id)).toMatchObject([{ id: queued.id }]);

    releaseRetry();
    await expect(retry).rejects.toMatchObject({ code: "not_a_handoff_retry" });
    await expect
      .poll(async () => (await rig.repos.turns.findById(queued.id))?.status)
      .toBe("complete");
    await rig.untilSettled();

    expect(await rig.inbox.selectPending(rig.thread.id)).toEqual([]);
    expect(
      (await rig.repos.turns.listByThread(rig.thread.id)).some(
        (turn) => turn.role === "assistant" && turn.status === "complete",
      ),
    ).toBe(true);
  });

  it("repairs a failed ending transaction and answers a message waiting behind the brief", async () => {
    const rig = await runtimeScenario({
      gateway: scriptedGateway({ usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    const source = await rig.repos.threads.create({
      userId: rig.userId,
      projectId: rig.project.id,
    });
    const cutoff = await rig.repos.turns.create({
      threadId: source.id,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    const seed = await rig.repos.turns.create({
      threadId: rig.thread.id,
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
    const queued = await rig.delivery.enqueue({
      threadId: rig.thread.id,
      intent: "message",
      provenance: { kind: "writer", actorId: rig.userId },
      body: { kind: "text", text: "Please answer after the brief." },
      idempotencyKey: "queued-behind-failing-brief",
    });
    const wakeIfRunnable = createWakeIfRunnable({
      delivery: rig.delivery,
      runStarter: { start: (threadId) => rig.startDrain(threadId) },
    });
    const service = createHandoffBriefs({
      repos: {
        ...rig.repos,
        async transaction() {
          throw new Error("ending transaction failed");
        },
      },
      eventWriter: rig.eventWriter,
      eventSink: rig.deps.eventSink,
      threadLock: {
        withThreadLock: (_threadId, operation) => operation(),
      },
      runClaim: rig.runClaim,
      wakeIfRunnable,
      billingUsage: rig.deps.billingUsage,
      async generate() {
        return {
          outcome: {
            kind: "complete",
            text: "Unused brief result.",
            model: "test-model",
            modelResponses: [],
            summarizer: { path: "branch", segments: 1 },
          },
        };
      },
      async publishStatus() {},
      schedulePostCommit(task) {
        void task();
      },
    });
    const claim = required(await service.hold(rig.thread.id));
    service.launchAfterCommit({
      threadId: rig.thread.id,
      seedTurnId: seed.id,
      claim,
    });

    await expect.poll(async () => (await rig.repos.turns.findById(seed.id))?.status).toBe("error");
    await expect
      .poll(async () => (await rig.repos.turns.findById(queued.id))?.status)
      .toBe("complete");
    await rig.untilSettled();

    expect(await rig.repos.turns.findById(seed.id)).toMatchObject({
      status: "error",
      metadata: { reason: "interrupted", phase: "recovery" },
    });
    expect(await rig.repos.turns.findById(queued.id)).toMatchObject({
      role: "user",
      status: "complete",
    });
    expect(
      (await rig.repos.turns.listByThread(rig.thread.id)).some(
        (turn) => turn.role === "assistant" && turn.status === "complete",
      ),
    ).toBe(true);
  });
});
