/** The selector's table: where a queued write-mode switch S runs relative to messages and controls. */
import type { ControlBody } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { next } from "./next-inbox-work.js";
import type { InboxMessage } from "./ports.js";

let seq = 0;
function row(id: string, intent: InboxMessage["intent"], body: InboxMessage["body"]): InboxMessage {
  seq += 1;
  return {
    id,
    threadId: "thread",
    seq,
    intent,
    body,
    provenance: { kind: "writer", actorId: "writer" },
    idempotencyKey: id,
    enqueuedAt: new Date(0).toISOString(),
    deliveredAt: null,
  };
}
const message = (id: string) => row(id, "message", { kind: "text", text: id });
const notice = (id: string) => row(id, "notice", { kind: "text", text: id });
const control = (id: string, body: ControlBody) => row(id, "control", body);
const S = () => control("S", { kind: "write_mode", mode: "draft" });
const C = () => control("C", { kind: "compact" });

function describeSelection(selection: ReturnType<typeof next>) {
  switch (selection.kind) {
    case "batch":
      return `batch ${selection.rows.map((entry) => entry.id).join(",")}`;
    case "control":
    case "switch":
      return `${selection.kind} ${selection.control.id}`;
    default:
      return selection.kind;
  }
}

describe("next", () => {
  it.each([
    { name: "S, M2", pending: () => [S(), message("M2")], boundary: "yield", runStart: "switch S" },
    {
      name: "M1, S",
      pending: () => [message("M1"), S()],
      boundary: "batch M1",
      runStart: "batch M1",
    },
    {
      name: "M1, S, M2",
      pending: () => [message("M1"), S(), message("M2")],
      boundary: "yield",
      runStart: "switch S",
    },
    { name: "S", pending: () => [S()], boundary: "none", runStart: "switch S" },
    { name: "S, N", pending: () => [S(), notice("N")], boundary: "batch N", runStart: "switch S" },
    {
      name: "C, S, M2",
      pending: () => [C(), S(), message("M2")],
      boundary: "yield",
      runStart: "switch S",
    },
    { name: "C, S", pending: () => [C(), S()], boundary: "none", runStart: "control C" },
    {
      name: "C, M2",
      pending: () => [C(), message("M2")],
      boundary: "batch M2",
      runStart: "batch M2",
    },
    { name: "N", pending: () => [notice("N")], boundary: "batch N", runStart: "none" },
  ])("$name → boundary $boundary, run start $runStart", ({ pending, boundary, runStart }) => {
    const rows = pending();
    expect(describeSelection(next(rows, "boundary"))).toBe(boundary);
    expect(describeSelection(next(rows, "run_start"))).toBe(runStart);
  });
});
