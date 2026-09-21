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

function runnerStub() {
  let view: { assistantTurnId: TurnId | null; startedAt: Date } | null = null;
  return {
    getRunningTurn: () => view,
    set(next: { assistantTurnId: TurnId | null; startedAt: Date } | null) {
      view = next;
    },
  };
}

async function harness(recordsOverride?: AdmissionPersistencePort) {
  const projects = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects });
  const project = await projects.create({ userId: USER, title: "Writer" });
  const thread = await repos.threads.create({ userId: USER, projectId: project.id });
  const inbox = createInMemoryInbox();
  const runStarter = createInMemoryRunStarter();
  const journal = createInMemoryEventJournalWriter();
  const records = fakeRecords();
  const runner = runnerStub();
  const producer = createWriterTurnProducer({
    persistence: { repos, eventWriter: journal },
    hub: journal,
    runner,
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
    records: recordsOverride ?? records.port,
    consumeUploads: async () => undefined,
    attachDocument: async () => undefined,
  });
  return { producer, repos, inbox, runStarter, journal, records, runner, thread };
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

  it("stamps activated skill slugs on the writer turn so the drain can inline them", async () => {
    const { producer, repos, thread } = await harness();
    const base = input(thread.id);

    const result = await producer.enqueue({
      ...base,
      admission: { ...base.admission, activatedSkillSlugs: ["writing-principles"] },
    });

    if (!("userTurnId" in result)) throw new Error("expected accepted admission");
    const turn = await repos.turns.findById(result.userTurnId);
    expect(turn?.metadata).toEqual({ activatedSkillSlugs: ["writing-principles"] });
  });

  it("merges a mid-run send onto the live assistant turn instead of conflicting", async () => {
    const { producer, repos, runStarter, runner, thread } = await harness();
    const running = await repos.turns.create({
      id: crypto.randomUUID() as TurnId,
      threadId: thread.id,
      prevTurnId: null,
      role: "assistant",
      status: "streaming",
    });
    runner.set({ assistantTurnId: running.id, startedAt: new Date(0) });

    const result = await producer.enqueue(input(thread.id, "steer"));

    expect(result).toMatchObject({ kind: "accepted", assistantTurnId: running.id });
    expect(runStarter.started).toEqual([thread.id]);
    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });

  it("treats a crash-orphaned streaming turn as no live run on the next send", async () => {
    const { producer, repos, runner, thread } = await harness();
    await repos.turns.create({
      id: crypto.randomUUID() as TurnId,
      threadId: thread.id,
      prevTurnId: null,
      role: "assistant",
      status: "streaming",
    });

    // The runner map is empty after a crash; durable status must not revive it.
    runner.set(null);
    const result = await producer.enqueue(input(thread.id, "after-crash"));

    expect(result).toMatchObject({ kind: "accepted", assistantTurnId: null });
  });

  it("returns the parked turn for a send while the run waits on an interrupt", async () => {
    const { producer, repos, runner, thread } = await harness();
    const parked = await repos.turns.create({
      id: crypto.randomUUID() as TurnId,
      threadId: thread.id,
      prevTurnId: null,
      role: "assistant",
      status: "waiting_interrupt",
    });

    // Setup window: the runner owns the thread but has not published the id.
    runner.set({ assistantTurnId: null, startedAt: new Date(0) });
    const result = await producer.enqueue(input(thread.id, "answer"));

    expect(result).toMatchObject({ kind: "accepted", assistantTurnId: parked.id });
  });

  it("never lets the setup-window fallback pick a pre-run orphan", async () => {
    const { producer, repos, runner, thread } = await harness();
    await repos.turns.create({
      id: crypto.randomUUID() as TurnId,
      threadId: thread.id,
      prevTurnId: null,
      role: "assistant",
      status: "streaming",
    });

    // A fresh run owns the thread but has not persisted its container yet; the
    // only durable non-terminal row is an orphan from before this run started.
    runner.set({ assistantTurnId: null, startedAt: new Date(Date.now() + 1_000) });
    const result = await producer.enqueue(input(thread.id, "fresh-run"));

    expect(result).toMatchObject({ kind: "accepted", assistantTurnId: null });
  });

  it("rolls the writer turn back when another settlement already won", async () => {
    const base = fakeRecords();
    const winner: AdmissionPersistencePort = {
      ...base.port,
      async accept() {
        return {
          kind: "winner",
          record: {
            state: "rejected",
            fingerprint: null,
            code: "recovery_no_committed_turn",
          },
        };
      },
    };
    const { producer, repos, runner, thread } = await harness(winner);
    runner.set(null);

    const result = await producer.enqueue(input(thread.id, "late"));

    expect(result).toEqual({
      kind: "rejected",
      submissionId: "submission-1",
      code: "recovery_no_committed_turn",
    });
    expect(await repos.turns.listByThread(thread.id)).toHaveLength(0);
    expect(base.accepted).toHaveLength(0);
  });
});
