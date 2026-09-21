/**
 * U1 writer producer: a send persists its user turn at enqueue, appends a
 * writer-provenance message under the same id, wakes the thread, and returns a
 * null assistant turn for a fresh run (a live run's turn for a mid-run merge).
 */
import type { AcceptedAdmission } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunStarter,
  createInMemoryThreadLock,
} from "../adapters/in-memory/loop-ports.js";
import { createThreadedInbox } from "../loop/threaded-inbox.js";
import type { AdmissionPersistencePort } from "./drizzle-admission-records.js";
import { createWriterTurnProducer } from "./writer-turn-producer.js";

const USER = "00000000-0000-4000-8000-000000000001" as never;

function fakeRecords() {
  const accepted: AcceptedAdmission[] = [];
  const port: AdmissionPersistencePort = {
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
      accepted.push(input.response);
      return { kind: "accepted", response: input.response };
    },
  };
  return { port, accepted };
}

async function harness() {
  const projects = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects });
  const project = await projects.create({ userId: USER, title: "Writer" });
  const thread = await repos.threads.create({ userId: USER, projectId: project.id });
  const inbox = createInMemoryInbox();
  const runStarter = createInMemoryRunStarter();
  const journal = createInMemoryEventJournalWriter();
  const records = fakeRecords();
  const producer = createWriterTurnProducer({
    persistence: { repos, eventWriter: journal },
    hub: journal,
    turns: repos.turns,
    threadedInbox: createThreadedInbox({
      inbox,
      threadLock: createInMemoryThreadLock(),
      runStarter,
      schedulePostCommit: (task) => {
        void task();
      },
    }),
    workContextDelivery: { async beforeTurn() {} },
    records: records.port,
    consumeUploads: async () => undefined,
    attachDocument: async () => undefined,
  });
  return { producer, repos, inbox, runStarter, journal, records, thread };
}

function input(threadId: ThreadId, text = "hello") {
  return {
    admission: {
      actorUserId: USER,
      threadId,
      submissionId: "submission-1",
      text,
      blocks: [{ type: "text" as const, text }],
      references: [],
    },
    fingerprint: "fingerprint",
    blocks: [{ type: "text" as const, text }],
    references: [],
  };
}

describe("createWriterTurnProducer", () => {
  it("persists the writer turn at enqueue, enqueues the message, and wakes", async () => {
    const { producer, repos, inbox, runStarter, thread } = await harness();

    const result = await producer.enqueue(input(thread.id));

    expect(result).toMatchObject({ kind: "accepted", assistantTurnId: null });
    if (!("userTurnId" in result)) throw new Error("expected accepted admission");
    const turns = await repos.turns.listByThread(thread.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("user");

    const pending = await inbox.claimPending(thread.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(result.userTurnId);
    expect(pending[0]?.provenance).toEqual({ kind: "writer", actorId: USER });

    expect(runStarter.started).toEqual([thread.id]);
  });

  it("merges a mid-run send onto the live assistant turn instead of conflicting", async () => {
    const { producer, repos, runStarter, thread } = await harness();
    const running = await repos.turns.create({
      id: crypto.randomUUID() as TurnId,
      threadId: thread.id,
      prevTurnId: null,
      role: "assistant",
      status: "streaming",
    });

    const result = await producer.enqueue(input(thread.id, "steer"));

    expect(result).toMatchObject({ kind: "accepted", assistantTurnId: running.id });
    expect(runStarter.started).toEqual([thread.id]);
    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });
});
