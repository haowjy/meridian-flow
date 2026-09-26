/**
 * The pending-inbox read model and its enqueue signal. `projectPendingInbox`
 * is the one durable-rows-to-tray transform; the notifying inbox decorates the
 * producer enqueue with a best-effort, thread-lock-serialized `inbox.changed`
 * append after commit. A failed append never fails the producer.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import type { EventJournalWriter } from "../../threads/index.js";
import { projectPendingInbox } from "./pending-inbox.js";
import type { InboxMessage, MessageDraft } from "./ports.js";

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

function _message(key: string): MessageDraft {
  return {
    threadId: THREAD_A,
    intent: "message",
    provenance: { kind: "writer", actorId: "user-1" },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

function _recordingWriter(): { writer: EventJournalWriter; appended: OrchestratorEvent[] } {
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
        provenance: {
          kind: "child",
          threadId: "child-1",
          reportId: "report-1",
          handle: "p1",
          outcome: "succeeded",
        },
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
      handle: "p1",
      outcome: "succeeded",
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
    ).toEqual(["awaiting_run", "waiting"]);
  });
});
