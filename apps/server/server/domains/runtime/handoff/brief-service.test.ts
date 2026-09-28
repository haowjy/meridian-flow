/** Pure service contracts for handoff recovery and clean claim loss. */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryRepositories } from "../../threads/adapters/in-memory/repositories.js";
import { HandoffSeedMetadataCodec } from "../../threads/index.js";
import { createInMemoryHandoffBriefClaim } from "../adapters/in-memory/handoff-brief-claim.js";
import { createRuntimeHarness } from "../loop/__tests__/runtime-harness.js";
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
      launches: 0,
    },
  });
  return { rig, source, destination, seed };
}

function makeService(
  state: Awaited<ReturnType<typeof createFixture>>,
  options: {
    generate?: Parameters<typeof createHandoffBriefs>[0]["generate"];
    claim?: Parameters<typeof createHandoffBriefs>[0]["claim"];
  } = {},
) {
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
    claim: options.claim ?? createInMemoryHandoffBriefClaim(),
    runClaim: state.rig.runClaim,
    runStarter: { async start() {} },
    billingUsage: state.rig.deps.billingUsage,
    generate:
      options.generate ??
      (async () => ({
        outcome: {
          kind: "complete" as const,
          text: "Summary",
          model: "writer-model",
          modelResponses: [],
          summarizer: { path: "branch" as const, segments: 1 },
        },
      })),
    async publishStatus() {},
    schedulePostCommit(task) {
      scheduled.push(task);
    },
  });
  return { service, scheduled };
}

describe("handoff brief service", () => {
  it("settles a repeatedly crashing seed at the launch limit without another call", async () => {
    const state = await createFixture();
    expect(HandoffSeedMetadataCodec.safeParse(state.seed.metadata).success).toBe(true);
    expect(await state.rig.repos.turns.findById(state.seed.id)).not.toBeNull();
    await state.rig.repos.turns.updateStatus(state.seed.id, {
      status: "pending",
      metadata: { ...HandoffSeedMetadataCodec.parse(state.seed.metadata), launches: 3 },
    });
    const generate = vi.fn();
    const { service } = makeService(state, { generate });

    await service.launch(state.seed.id);

    expect(generate).not.toHaveBeenCalled();
    expect(await state.rig.repos.turns.findById(state.seed.id)).toMatchObject({
      status: "error",
      metadata: { launches: 3, reason: "interrupted", phase: "recovery" },
    });
  });

  it("leaves the seed pending and restores its launch count when the claim is lost", async () => {
    const state = await createFixture();
    const listeners = new Set<() => void>();
    const claim = {
      async tryAcquire() {
        return {
          onLost(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async release() {},
        };
      },
    };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { service } = makeService(state, {
      claim,
      async generate({ signal }) {
        markStarted();
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                outcome: {
                  kind: "cancelled",
                  modelResponses: [],
                  summarizer: { path: "branch", segments: 1 },
                },
              }),
            { once: true },
          );
        });
      },
    });

    const launching = service.launch(state.seed.id);
    await started;
    for (const listener of listeners) listener();
    await launching;

    expect(await state.rig.repos.turns.findById(state.seed.id)).toMatchObject({
      status: "pending",
      metadata: { launches: 0 },
    });
    expect(await state.rig.repos.turns.hasPendingHandoffSeed(state.destination.id)).toBe(true);
  });
});
