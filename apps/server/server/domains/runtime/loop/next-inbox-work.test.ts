import { describe, expect, it } from "vitest";
import { next } from "./next-inbox-work.js";
import type { InboxMessage } from "./ports.js";

function row(input: Pick<InboxMessage, "id" | "intent" | "body"> & { runsFirst?: boolean }) {
  return {
    threadId: "thread",
    provenance: { kind: "writer", actorId: "writer" },
    seq: 1,
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    idempotencyKey: input.id,
    ...input,
    runsFirst: input.runsFirst ?? false,
  } satisfies InboxMessage;
}

const message = row({ id: "message", intent: "message", body: { kind: "text", text: "hello" } });
const compact = row({ id: "compact", intent: "control", body: { kind: "compact" } });
const notice = row({
  id: "notice",
  intent: "notice",
  body: { kind: "context", parts: [{ source: "work", text: "work context note" }] },
});

describe("next inbox work", () => {
  it("serves messages at a boundary and leaves controls for a run start", () => {
    expect(next([compact, message], "boundary")).toEqual({ kind: "messages", rows: [message] });
  });

  it("serves messages before a queued command regardless of enqueue order", () => {
    expect(next([compact, message], "run_start")).toEqual({ kind: "messages", rows: [message] });
  });

  it("selects one command only when no message is waiting", () => {
    expect(next([compact], "run_start")).toMatchObject({
      kind: "control",
      control: compact,
      rows: [],
    });
  });

  it("lets a Stop-stamped command run first with the waiting messages", () => {
    const stamped = row({
      ...compact,
      id: "stamped",
      runsFirst: true,
    });
    expect(next([stamped, message], "run_start")).toEqual({
      kind: "control",
      control: stamped,
      rows: [message],
    });
  });

  it("does not wake for a Work refresh notice alone", () => {
    const workRefresh = row({
      id: "notice",
      intent: "notice",
      body: { kind: "work_context_refresh" },
    });
    expect(next([workRefresh], "run_start")).toEqual({ kind: "none" });
  });

  it("adopts pending notices when a direct writer message starts the run", () => {
    expect(next([notice], "run_start")).toEqual({ kind: "none" });
    expect(next([notice, message], "run_start")).toEqual({
      kind: "messages",
      rows: [notice, message],
    });
  });

  it("co-adopts non-message notices with a runnable command", () => {
    expect(next([compact, notice], "run_start")).toEqual({
      kind: "control",
      control: compact,
      rows: [notice],
    });
  });
});
