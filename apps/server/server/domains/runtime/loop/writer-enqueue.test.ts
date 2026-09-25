/**
 * The writer's turn is persisted at enqueue; the drain start recognizes it
 * through `knownTurnIds` and mints only the assistant container, never a second
 * user turn for the same message.
 */
import type { AcceptedAdmission } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryThreadLock } from "../adapters/in-memory/loop-ports.js";
import type { AdmissionPersistencePort } from "../admission/drizzle-admission-records.js";
import { createWriterTurnProducer } from "../admission/writer-turn-producer.js";
import { createThreadedInbox } from "../loop/threaded-inbox.js";
import { RuntimeTestRig } from "./__tests__/runtime-test-rig.js";
import { createInertGateway } from "./__tests__/test-gateway.js";

function fakeRecords(): AdmissionPersistencePort {
  return {
    async lookup() {
      return null;
    },
    async recoverExpiredPending() {
      return null;
    },
    async reserve() {
      return { kind: "reserved" };
    },
    async reject() {
      throw new Error("unexpected rejection");
    },
    async retire(request) {
      return { kind: "retired", submissionId: request.submissionId, code: "retired" };
    },
    async accept(input) {
      return { kind: "accepted", response: input.response as AcceptedAdmission };
    },
  };
}

describe("writer enqueue through the drain", () => {
  it("drains the pre-persisted turn instead of re-persisting it", async () => {
    const rig = await RuntimeTestRig.create({ gateway: createInertGateway("stub-model") });
    const producer = createWriterTurnProducer({
      inbox: rig.inbox,
      persistence: { repos: rig.repos, eventWriter: rig.hub },
      hub: rig.hub,
      runner: rig.runner,
      turns: rig.repos.turns,
      threadedInbox: createThreadedInbox({
        inbox: rig.inbox,
        threadLock: createInMemoryThreadLock(),
        runStarter: {
          async start(threadId) {
            await rig.runner.startDrain(threadId);
          },
        },
        schedulePostCommit: (task) => {
          void task();
        },
      }),
      workContextDelivery: { async beforeTurn() {} },
      records: fakeRecords(),
      consumeUploads: async () => undefined,
      attachDocument: async () => undefined,
    });

    const result = await producer.enqueue({
      admission: {
        actorUserId: rig.userId as never,
        threadId: rig.thread.id,
        submissionId: "writer-drain-1",
        text: "hello",
        blocks: [{ type: "text", text: "hello" }],
        references: [],
      },
      fingerprint: "fingerprint",
      blocks: [{ type: "text", text: "hello" }],
      references: [],
    });
    if (!("userTurnId" in result)) throw new Error("expected accepted admission");

    await vi.waitFor(() => expect(rig.runner.isThreadRunning(rig.thread.id)).toBe(false));

    const turns = await rig.repos.turns.listByThread(rig.thread.id);
    const userTurns = turns.filter((turn) => turn.role === "user");
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]?.id).toBe(result.userTurnId);
    expect(turns.filter((turn) => turn.role === "assistant")).toHaveLength(1);
  });
});
