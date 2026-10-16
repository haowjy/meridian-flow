/** `messageFate` against the four #768 defects and its two refusals, from plain snapshot fixtures. */
import type { ThreadSnapshotResponse, Turn } from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { messageFate } from "./message-fate";

const record = (
  version: string,
  executionId: string | null,
  items: RunState["items"] = [],
): RunState => ({
  version,
  items,
  sentThrough: 0,
  execution: executionId ? { executionId, currentTurnId: null } : null,
  mode: "direct",
  blocked: null,
});
const user = (id: string, position: number, byTurnId: string | null) =>
  ({
    id,
    role: "user",
    position,
    executionId: null,
    delivery: { byTurnId },
    metadata: null,
  }) as unknown as Turn;
const reply = (
  id: string,
  position: number,
  executionId: string,
  status: Turn["status"],
  retryOf?: string,
) =>
  ({
    id,
    role: "assistant",
    position,
    executionId,
    status,
    delivery: null,
    metadata: retryOf ? { retryOf } : null,
  }) as unknown as Turn;
const compaction = (id: string, position: number, executionId: string, status: Turn["status"]) =>
  ({ ...reply(id, position, executionId, status), role: "compaction" }) as unknown as Turn;
// A write-mode switch turn carries no execution, so it can never be a reply's last turn.
const switchTurn = (id: string, position: number) =>
  ({
    id,
    role: "system",
    position,
    executionId: null,
    status: "complete",
    delivery: null,
    metadata: null,
  }) as unknown as Turn;
const fate = (
  turns: Turn[],
  rec: RunState,
  messageId = "m",
  admittedVersion: string | null = "10",
) =>
  messageFate({
    messageId,
    admittedVersion,
    read: { turns, liveState: { runState: rec } as ThreadSnapshotResponse["liveState"] },
  });

describe("messageFate", () => {
  it("binds a steered message to the reply that took it, not the one it steered", () => {
    // Risk: defect 1, M2 steered A, but B (a new execution) delivered it.
    const turns = [
      reply("a", 1, "e1", "complete"),
      user("m", 2, "b"),
      reply("b", 3, "e2", "complete"),
    ];
    const result = fate(turns, record("20", null));
    expect(result).toMatchObject({ kind: "answered", answeredBy: "b", last: { id: "b" } });
  });

  it("ends on a failed successor, not the earlier success", () => {
    // Risk: defect 2, falling back to A's success after B errored in the same execution.
    const turns = [
      user("m", 1, "a"),
      reply("a", 2, "e1", "complete"),
      reply("b", 3, "e1", "error"),
    ];
    const result = fate(turns, record("20", null));
    expect(result).toMatchObject({
      kind: "answered",
      answeredBy: "a",
      last: { id: "b", status: "error" },
    });
  });

  it("ends on a cancelled compaction after a continuation", () => {
    // Risk: defect 3, waiting forever or reporting complete after the compaction was cancelled;
    // a trailing switch turn must not become the last turn either.
    const turns = [
      user("m", 1, "a"),
      reply("a", 2, "e1", "complete"),
      compaction("c", 3, "e1", "cancelled"),
      switchTurn("sw", 4),
    ];
    expect(fate(turns, record("20", null))).toMatchObject({
      kind: "answered",
      last: { id: "c", status: "cancelled" },
    });
  });

  it("follows a Retry of a Retry through its executions", () => {
    // Risk: defect 4, a snapshot that cannot rebuild Retry chains.
    const base = [
      user("m", 1, "f"),
      reply("f", 2, "e1", "error"),
      reply("r1", 3, "e2", "error", "f"),
    ];
    const open = [...base, reply("r2", 4, "e3", "streaming", "r1")];
    expect(fate(open, record("20", "e3"))).toMatchObject({
      kind: "answering",
      chain: ["f", "r1", "r2"],
      last: { id: "r2" },
    });
    const done = [...base, reply("r2", 4, "e3", "complete", "r1")];
    expect(fate(done, record("30", null))).toMatchObject({
      kind: "answered",
      answeredBy: "f",
      last: { id: "r2", status: "complete" },
    });
  });

  it("keeps a forgotten deliverer findable so a successful Retry still proves the Retry", () => {
    // Risk: filtering forgotten turns would lose the Retry chain after the failed reply was stamped.
    const turns = [
      user("m", 1, "f"),
      { ...reply("f", 2, "e1", "error"), forgottenBy: "r" } as Turn,
      reply("r", 3, "e2", "complete", "f"),
    ];
    expect(fate(turns, record("20", null))).toMatchObject({
      kind: "answered",
      answeredBy: "f",
      last: { id: "r", status: "complete" },
    });
  });

  it("reads a stamped writer message as forgotten, never answered by the reply that moved on", () => {
    // Risk: after moving on, a later reply was attributed to the forgotten message (live shape in
    // the FF2 verification's move-on snapshot: writer and failed reply stamped, then a later success).
    const turns = [
      { ...user("m", 1, "f"), forgottenBy: "n" } as Turn,
      { ...reply("f", 2, "e1", "error"), forgottenBy: "n" } as Turn,
      user("n", 3, "g"),
      reply("g", 4, "e2", "complete"),
    ];
    expect(fate(turns, record("20", null))).toEqual({ kind: "forgotten", forgottenBy: "n" });
  });

  it("reads absence as a hand-back only at a record that covers the admission", () => {
    // Risk: a stale record read as a hand-back.
    expect(fate([], record("5", null))).toEqual({ kind: "waiting", blocked: false });
    expect(fate([], record("10", null))).toEqual({ kind: "handedBack" });
  });

  it("refuses to claim an answer with no deliverer", () => {
    // Risk: claiming an answer for a message delivered by no reserved turn.
    expect(fate([user("m", 1, null)], record("20", null))).toEqual({
      kind: "unproven",
      reason: "deliverer_unknown",
    });
  });
});
