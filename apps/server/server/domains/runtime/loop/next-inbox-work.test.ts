import { describe, expect, it } from "vitest";
import { next } from "./next-inbox-work.js";
import type { InboxMessage } from "./ports.js";

function row(input: Pick<InboxMessage, "id" | "intent" | "body" | "seq">) {
  return {
    threadId: "thread",
    provenance: { kind: "writer", actorId: "writer" },

    enqueuedAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    idempotencyKey: input.id,
    ...input,
  } satisfies InboxMessage;
}

const message = row({
  id: "message",
  seq: 1,
  intent: "message",
  body: { kind: "text", text: "hello" },
});
const compact = row({ id: "compact", seq: 2, intent: "control", body: { kind: "compact" } });
const workRefresh = row({
  id: "notice",
  seq: 1,
  intent: "notice",
  body: { kind: "work_context_refresh" },
});

describe("next inbox work", () => {
  it("adopts every non-command row at a boundary", () => {
    const after = row({
      id: "after",
      seq: 3,
      intent: "message",
      body: { kind: "text", text: "after" },
    });
    expect(next([message, compact, after], "boundary")).toEqual({
      kind: "batch",
      rows: [message, after],
    });
    expect(next([compact, after], "boundary")).toEqual({ kind: "batch", rows: [after] });
  });

  it("takes the same ordered prefix at run start", () => {
    expect(next([message, compact], "run_start")).toEqual({ kind: "batch", rows: [message] });
  });

  it("answers all messages before an older command", () => {
    expect(next([compact, message], "run_start")).toEqual({ kind: "batch", rows: [message] });
  });

  it("runs an oldest command by itself when no message is waiting", () => {
    expect(next([workRefresh, compact], "run_start")).toEqual({
      kind: "control",
      control: compact,
      rows: [],
    });
  });

  it("does not start a run for notices alone", () => {
    expect(next([workRefresh], "run_start")).toEqual({ kind: "none" });
  });
});
