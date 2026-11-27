import type { ThreadSnapshotResponse, Turn } from "@meridian/contracts/protocol";
import type { PendingInboxItem, RunState } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  handBackCandidates,
  hiddenWriterTurns,
  isBlockedForUsage,
  isBusy,
  isOwed,
  stopRequest,
  stopStatus,
  usageBlockedMessages,
  waitingWriterMessages,
} from "./fold-messages";
import { messageFate } from "./message-fate";
import { type RetryEntry, reconcileRetries } from "./retry";
import {
  addIntent,
  answerIntent,
  INITIAL_RUN_STATE_VIEW,
  type RunStateView,
  receiveRecord,
} from "./run-state-view";

const message = (
  id: string,
  seq: number,
  deliveryState: PendingInboxItem["deliveryState"] = "waiting",
): PendingInboxItem => ({
  id,
  seq,
  intent: "message",
  provenance: { kind: "writer", actorId: "w" },
  deliveryState,
  summary: id,
  enqueuedAt: "t",
});
const control: PendingInboxItem = {
  id: "sw",
  seq: 9,
  intent: "control",
  control: { kind: "write_mode", mode: "draft" },
  provenance: { kind: "writer", actorId: "w" },
  deliveryState: "waiting",
  summary: "",
  enqueuedAt: "t",
};
const record = (version: string, patch: Partial<RunState> = {}): RunState => ({
  version,
  items: [],
  sentThrough: 0,
  execution: null,
  mode: "direct",
  blocked: null,
  ...patch,
});
const viewOf = (state: RunState): RunStateView => receiveRecord(INITIAL_RUN_STATE_VIEW, state);

describe("message folds", () => {
  it("is busy with an open execution, a waiting message or an admitted message, and idle otherwise", () => {
    expect(isBusy(INITIAL_RUN_STATE_VIEW)).toBe(false);
    expect(isBusy(viewOf(record("1999")))).toBe(false);
    const running = viewOf(record("2999", { execution: { executionId: "e", currentTurnId: "a" } }));
    expect(isBusy(running)).toBe(true);
    expect(isBusy(viewOf(record("3999", { items: [message("m1", 1)] })))).toBe(true);
    const admitted = addIntent(INITIAL_RUN_STATE_VIEW, {
      kind: "message",
      id: "m1",
      answer: "4000",
    });
    expect(isBusy(admitted)).toBe(true);
    expect(isBusy(receiveRecord(admitted, record("4999")))).toBe(false);
  });

  it("never counts a switch as a writer message", () => {
    const view = addIntent(viewOf(record("1999", { items: [control], sentThrough: 0 })), {
      kind: "switch",
      id: "sw2",
      order: 1,
      mode: "direct",
      answer: null,
    });
    expect(isBusy(view)).toBe(false);
    expect(waitingWriterMessages(view, [])).toEqual([]);
    expect(stopRequest(view, "r").mine).toEqual([]);
  });

  it("shows awaiting messages in the tray only while the start is blocked", () => {
    const items = [message("m1", 1, "awaiting_run"), message("m2", 2, "waiting")];
    expect(waitingWriterMessages(viewOf(record("1999", { items })), []).map((i) => i.id)).toEqual([
      "m2",
    ]);
    const blocked = record("2999", { items, blocked: { reason: "credits_exhausted" } });
    expect(waitingWriterMessages(viewOf(blocked), []).map((i) => i.id)).toEqual(["m1", "m2"]);

    expect(usageBlockedMessages(viewOf(blocked)).map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(usageBlockedMessages(viewOf(record("1999", { items })))).toEqual([]);
    expect(isBlockedForUsage(viewOf(blocked), "m1")).toBe(true);
    expect(isBlockedForUsage(viewOf(blocked), "m9")).toBe(false);
    expect(isOwed(viewOf(blocked), "m2")).toBe(true);
    expect(isOwed(viewOf(blocked), "m9")).toBe(false);
    const admitted = addIntent(INITIAL_RUN_STATE_VIEW, {
      kind: "message",
      id: "m9",
      answer: "5000",
    });
    expect(isOwed(admitted, "m9")).toBe(true);
    expect(isOwed(receiveRecord(admitted, record("5000")), "m9")).toBe(false);
  });

  it("builds Stop from the record the writer saw, and from nothing before the first", () => {
    const bare = addIntent(INITIAL_RUN_STATE_VIEW, { kind: "message", id: "m9", answer: "5000" });
    expect(stopRequest(bare, "req")).toEqual({
      requestId: "req",
      seenThrough: 0,
      seenExecutionId: null,
      mine: ["m9"],
    });
    const seen = viewOf(
      record("6999", { sentThrough: 4, execution: { executionId: "e1", currentTurnId: null } }),
    );
    expect(stopRequest(seen, "req2")).toMatchObject({ seenThrough: 4, seenExecutionId: "e1" });

    const idle = { request: "idle", cancelledExecutionId: null, failedStops: [] } as const;
    expect(stopStatus(seen, { ...idle, request: "pending" })).toBe("pending");
    expect(
      stopStatus(seen, { ...idle, failedStops: [{ targetExecutionId: null, candidates: 1 }] }),
    ).toBe("failed");
    expect(stopStatus(seen, { ...idle, cancelledExecutionId: "e1" })).toBe("stopping");
    expect(stopStatus(seen, idle)).toBe("idle");
    expect(
      stopStatus(receiveRecord(seen, record("7999")), { ...idle, cancelledExecutionId: "e1" }),
    ).toBe("idle");
  });

  it("hides only the waiting messages its press covered, while it is unanswered and not failed", () => {
    const before = viewOf(
      record("1999", { sentThrough: 3, items: [message("m2", 2), message("m3", 3)] }),
    );
    const scope = { seenThrough: 2, mine: ["m1"] };
    const candidates = handBackCandidates(before, scope);
    expect(candidates).toEqual(["m2", "m1"]);
    const pressed = addIntent(before, {
      kind: "handBack",
      id: "req",
      candidates,
      failed: false,
      answer: null,
    });
    expect([...hiddenWriterTurns(pressed)]).toEqual(["m2", "m1"]);
    const later = receiveRecord(
      pressed,
      record("2999", {
        sentThrough: 4,
        items: [message("m2", 2), message("m3", 3), message("m4", 4)],
      }),
    );
    expect(waitingWriterMessages(later, []).map((i) => i.id)).toEqual(["m3", "m4"]);
    const failed = addIntent(later, {
      kind: "handBack",
      id: "req",
      candidates,
      failed: true,
      answer: null,
    });
    expect(waitingWriterMessages(failed, []).map((i) => i.id)).toEqual(["m2", "m3", "m4"]);
    const answered = answerIntent(later, "handBack", "req", "3999");
    expect(hiddenWriterTurns(answered).size).toBe(2);
    expect(hiddenWriterTurns(receiveRecord(answered, record("3999"))).size).toBe(0);
  });
});

{
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
    ({
      ...reply(id, position, executionId, status),
      role: "compaction",
    }) as unknown as Turn;
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
      const turns = [
        reply("a", 1, "e1", "complete"),
        user("m", 2, "b"),
        reply("b", 3, "e2", "complete"),
      ];
      const result = fate(turns, record("20", null));
      expect(result).toMatchObject({ kind: "answered", answeredBy: "b", last: { id: "b" } });
    });

    it("ends on a failed successor, not the earlier success", () => {
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
      const turns = [
        { ...user("m", 1, "f"), forgottenBy: "n" } as Turn,
        { ...reply("f", 2, "e1", "error"), forgottenBy: "n" } as Turn,
        user("n", 3, "g"),
        reply("g", 4, "e2", "complete"),
      ];
      expect(fate(turns, record("20", null))).toEqual({ kind: "forgotten", forgottenBy: "n" });
    });

    it("reads absence as a hand-back only at a record that covers the admission", () => {
      expect(fate([], record("5", null))).toEqual({ kind: "waiting", blocked: false });
      expect(fate([], record("10", null))).toEqual({ kind: "handedBack" });
    });

    it("refuses to claim an answer with no deliverer", () => {
      expect(fate([user("m", 1, null)], record("20", null))).toEqual({
        kind: "unproven",
        reason: "deliverer_unknown",
      });
    });
  });
}

{
  const record = (version: string, executionId: string | null): RunState => ({
    version,
    items: [],
    sentThrough: 0,
    execution: executionId ? { executionId, currentTurnId: "x" } : null,
    mode: "direct",
    blocked: null,
  });
  const turn = (id: string, retryOf?: string) =>
    ({
      id,
      role: "assistant",
      metadata: retryOf ? { retryOf } : null,
    }) as unknown as Turn;
  const entry = (over: Partial<RetryEntry> = {}): RetryEntry => ({
    id: "r2",
    from: "r1",
    executionId: "e2",
    answerVersion: "5999",
    ...over,
  });
  const reconcile = (
    entries: RetryEntry[],
    storedTurns: Turn[],
    view = receiveRecord(INITIAL_RUN_STATE_VIEW, record("5999", "e2")),
    supersedes = true,
  ) => reconcileRetries({ entries, storedTurns, view, supersedes });

  it("keeps a Retry until its turn is stored and named, or its reservation ended without one", () => {
    const open = reconcile([entry()], [turn("r1")]);
    expect(open.standIns).toHaveLength(1);
    expect([...open.hidden]).toEqual(["r1"]);
    const stored = reconcile([entry()], [turn("r1"), turn("r2")]);
    expect(stored.remaining).toHaveLength(1);
    expect(stored.standIns).toHaveLength(0);
    expect([...stored.hidden]).toEqual(["r1"]);
    expect(reconcile([entry()], [turn("r1"), turn("c1", "r1"), turn("r2")]).remaining).toEqual([]);
    const ended = receiveRecord(INITIAL_RUN_STATE_VIEW, record("6999", null));
    expect(reconcile([entry()], [turn("r1")], ended).remaining).toEqual([]);
    const older = receiveRecord(INITIAL_RUN_STATE_VIEW, record("4999", null));
    expect(reconcile([entry()], [turn("r1")], older).remaining).toHaveLength(1);
    expect(reconcile([entry({ answerVersion: null })], [turn("r1")], ended).remaining).toHaveLength(
      1,
    );
    const brief = reconcile(
      [entry({ executionId: null, answerVersion: null })],
      [],
      undefined,
      false,
    );
    expect(brief.hidden.size).toBe(0);
    expect(reconcile([entry()], [turn("r2")], undefined, false).remaining).toEqual([]);
  });
}
