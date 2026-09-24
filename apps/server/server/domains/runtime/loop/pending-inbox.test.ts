/**
 * The pending-inbox read model and its enqueue signal. `projectPendingInbox`
 * is the one durable-rows-to-tray transform; the notifying inbox decorates the
 * producer enqueue with a best-effort, per-thread-serialized `inbox.changed`
 * append after commit. A failed append never fails the producer.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import type { EventJournalWriter } from "../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunStarter,
  createInMemoryThreadLock,
} from "../adapters/in-memory/loop-ports.js";
import { createNotifyingThreadedInbox, projectPendingInbox } from "./pending-inbox.js";
import type { InboxMessage, MessageDraft } from "./ports.js";
import { createThreadedInbox } from "./threaded-inbox.js";

const THREAD_A = "00000000-0000-4000-8000-0000000000a1" as ThreadId;

function inboxMessage(overrides: Partial<InboxMessage> & { id: string }): InboxMessage {
  return {
    threadId: THREAD_A,
    seq: 1,
    intent: "message",
    provenance: { kind: "writer", actorId: "user-1" },
    body: { kind: "text", text: "hello" },
    idempotencyKey: overrides.id,
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    ...overrides,
  };
}

function message(key: string): MessageDraft {
  return {
    threadId: THREAD_A,
    intent: "message",
    provenance: { kind: "writer", actorId: "user-1" },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

function recordingWriter(): { writer: EventJournalWriter; appended: OrchestratorEvent[] } {
  const appended: OrchestratorEvent[] = [];
  return {
    appended,
    writer: {
      async appendEvent(_threadId, event) {
        appended.push(event);
        return BigInt(appended.length);
      },
    },
  };
}

describe("projectPendingInbox", () => {
  it("maps the durable row, keeps seq order, and summarizes each body kind", () => {
    const pending = projectPendingInbox([
      inboxMessage({ id: "a", seq: 1 }),
      inboxMessage({
        id: "b",
        seq: 2,
        intent: "notice",
        provenance: { kind: "system", source: "work" },
        body: {
          kind: "context",
          parts: [
            { source: "work", text: "note one" },
            { source: "work", text: "note two" },
          ],
        },
      }),
      inboxMessage({
        id: "c",
        seq: 3,
        provenance: { kind: "child", threadId: "child-1", reportId: "report-1" },
        body: { kind: "text", text: "Read thread_report(...)" },
      }),
    ]);

    expect(pending.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(pending.items.map((item) => item.summary)).toEqual([
      "hello",
      "note one\n\nnote two",
      "Read thread_report(...)",
    ]);
    expect(pending.items.map((item) => item.deliveryState)).toEqual([
      "awaiting_run",
      "awaiting_run",
      "awaiting_run",
    ]);
    expect(pending.items[1].intent).toBe("notice");
    expect(pending.items[2].provenance).toEqual({
      kind: "child",
      threadId: "child-1",
      reportId: "report-1",
    });
  });

  it("distinguishes startup, adopted F, and waiting G from the live run snapshot", () => {
    const messages = [inboxMessage({ id: "F", seq: 1 }), inboxMessage({ id: "G", seq: 2 })];
    expect(projectPendingInbox(messages).items.map(({ deliveryState }) => deliveryState)).toEqual([
      "awaiting_run",
      "awaiting_run",
    ]);
    expect(
      projectPendingInbox(messages, { turnId: null, messageIds: [] }).items.map(
        ({ deliveryState }) => deliveryState,
      ),
    ).toEqual(["awaiting_run", "awaiting_run"]);
    expect(
      projectPendingInbox(messages, { turnId: "assistant-1", messageIds: ["F"] }).items.map(
        ({ deliveryState }) => deliveryState,
      ),
    ).toEqual(["consuming", "waiting"]);
  });
});

describe("createNotifyingThreadedInbox", () => {
  it("appends the recomputed pending rows after commit", async () => {
    const { writer, appended } = recordingWriter();
    const inbox = createInMemoryInbox();
    const scheduled: Array<() => Promise<void>> = [];
    const threaded = createNotifyingThreadedInbox({
      threadedInbox: createThreadedInbox({
        inbox,
        threadLock: createInMemoryThreadLock(),
        runStarter: createInMemoryRunStarter(),
        schedulePostCommit: (task) => void task(),
      }),
      eventWriter: writer,
      readPending: async (threadId) => projectPendingInbox(await inbox.listPending(threadId)),
      schedulePostCommit: (task) => {
        scheduled.push(task);
      },
      eventSink: createInMemoryEventSink(),
    });

    await threaded.enqueue(message("queued"));
    await Promise.all(scheduled.map((task) => task()));

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ type: "inbox.changed", threadId: THREAD_A });
    const event = appended[0];
    if (event.type !== "inbox.changed") throw new Error("expected inbox.changed");
    expect(event.pending.items.map((item) => item.summary)).toEqual(["queued"]);
  });

  it("keeps the enqueue when the signal append fails", async () => {
    const eventSink = createInMemoryEventSink();
    const inbox = createInMemoryInbox();
    const scheduled: Array<() => Promise<void>> = [];
    const threaded = createNotifyingThreadedInbox({
      threadedInbox: createThreadedInbox({
        inbox,
        threadLock: createInMemoryThreadLock(),
        runStarter: createInMemoryRunStarter(),
        schedulePostCommit: (task) => void task(),
      }),
      eventWriter: {
        async appendEvent() {
          throw new Error("append failed");
        },
      },
      readPending: async (threadId) => projectPendingInbox(await inbox.listPending(threadId)),
      schedulePostCommit: (task) => {
        scheduled.push(task);
      },
      eventSink,
    });

    const inserted = await threaded.enqueue(message("durable"));
    await Promise.all(scheduled.map((task) => task()));

    expect(inserted.idempotencyKey).toBe("durable");
    expect(await inbox.listPending(THREAD_A)).toHaveLength(1);
    expect(eventSink.events.some((event) => event.name === "inbox.changed.append_failed")).toBe(
      true,
    );
  });

  it("a delayed enqueue notifier reads current state after adoption and ack", async () => {
    const { writer, appended } = recordingWriter();
    const inbox = createInMemoryInbox();
    const scheduled: Array<() => Promise<void>> = [];
    const threadLock = createInMemoryThreadLock();
    let run: { turnId: string | null; messageIds: string[] } | null = null;
    const threaded = createNotifyingThreadedInbox({
      threadedInbox: createThreadedInbox({
        inbox,
        threadLock,
        runStarter: createInMemoryRunStarter(),
        schedulePostCommit: (task) => scheduled.push(task),
      }),
      eventWriter: writer,
      readPending: async (threadId) => {
        const projection = await inbox.readPendingProjection(threadId);
        return projectPendingInbox(projection.messages, run);
      },
      schedulePostCommit: (task) => scheduled.push(task),
      eventSink: createInMemoryEventSink(),
    });

    const queued = await threaded.enqueue(message("delayed-notifier"));
    run = { turnId: "assistant-1", messageIds: [queued.id] };
    await inbox.ack(THREAD_A, [queued.id]);
    await Promise.all(scheduled.map((task) => task()));

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ type: "inbox.changed", pending: { items: [] } });
  });
});
