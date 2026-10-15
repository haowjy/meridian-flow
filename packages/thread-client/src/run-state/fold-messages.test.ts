/** The message folds over the run-state view: busy, the tray, the Stop body, what a hand-back hides, Retry retirement. */
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
    // Risk: `tail --until-idle` or the composer reading idle while work remains, or busy forever.
    expect(isBusy(INITIAL_RUN_STATE_VIEW)).toBe(false);
    expect(isBusy(viewOf(record("1999")))).toBe(false);
    const running = viewOf(record("2999", { execution: { executionId: "e", currentTurnId: "a" } }));
    expect(isBusy(running)).toBe(true);
    expect(isBusy(viewOf(record("3999", { items: [message("m1", 1)] })))).toBe(true);
    // Before the first record only an admitted message says so; its record retires it.
    const admitted = addIntent(INITIAL_RUN_STATE_VIEW, {
      kind: "message",
      id: "m1",
      answer: "4000",
    });
    expect(isBusy(admitted)).toBe(true);
    expect(isBusy(receiveRecord(admitted, record("4999")))).toBe(false);
  });

  it("never counts a switch as a writer message", () => {
    // Risk: a queued write-mode switch shown in the tray, counted by Stop, or holding the chat busy.
    const view = addIntent(viewOf(record("1999", { items: [control], sentThrough: 0 })), {
      kind: "switch",
      id: "sw2",
      order: 1,
      mode: "direct",
      answer: null,
    });
    expect(isBusy(view)).toBe(false);
    expect(waitingWriterMessages(view)).toEqual([]);
    expect(stopRequest(view, "r").mine).toEqual([]);
  });

  it("shows awaiting messages in the tray only while the start is blocked", () => {
    // Risk: a message owed under a usage block hidden from the tray, or shown when it is not stuck.
    const items = [message("m1", 1, "awaiting_run"), message("m2", 2, "waiting")];
    expect(waitingWriterMessages(viewOf(record("1999", { items }))).map((i) => i.id)).toEqual([
      "m2",
    ]);
    const blocked = record("2999", { items, blocked: { reason: "credits_exhausted" } });
    expect(waitingWriterMessages(viewOf(blocked)).map((i) => i.id)).toEqual(["m1", "m2"]);

    // The same record answers the app's notice and `./mf`'s guards: blocked messages, and owed.
    expect(usageBlockedMessages(viewOf(blocked)).map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(usageBlockedMessages(viewOf(record("1999", { items })))).toEqual([]);
    expect(isBlockedForUsage(viewOf(blocked), "m1")).toBe(true);
    expect(isBlockedForUsage(viewOf(blocked), "m9")).toBe(false);
    expect(isOwed(viewOf(blocked), "m2")).toBe(true);
    expect(isOwed(viewOf(blocked), "m9")).toBe(false);
    // An admitted message no record covers yet is owed; a covering record without it is not.
    const admitted = addIntent(INITIAL_RUN_STATE_VIEW, {
      kind: "message",
      id: "m9",
      answer: "5000",
    });
    expect(isOwed(admitted, "m9")).toBe(true);
    expect(isOwed(receiveRecord(admitted, record("5000")), "m9")).toBe(false);
  });

  it("builds Stop from the record the writer saw, and from nothing before the first", () => {
    // Risk: a Stop with no record claiming it saw an execution, or losing this device's messages.
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

    // Stop's control: a request out or failed stands as it is; an answer that cancelled an
    // execution reads Stopping while the record still shows it, and any other answer is idle.
    const idle = { request: "idle", cancelledExecutionId: null } as const;
    expect(stopStatus(seen, { ...idle, request: "pending" })).toBe("pending");
    expect(stopStatus(seen, { ...idle, request: "failed" })).toBe("failed");
    expect(stopStatus(seen, { ...idle, cancelledExecutionId: "e1" })).toBe("stopping");
    expect(stopStatus(seen, idle)).toBe("idle");
    expect(
      stopStatus(receiveRecord(seen, record("7999")), { ...idle, cancelledExecutionId: "e1" }),
    ).toBe("idle");
  });

  it("hides only the waiting messages its press covered, while it is unanswered and not failed", () => {
    // Risk: a hand-back hiding delivered history under the watermark, or a message sent after the press.
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
    // A later send is not hidden, and the folds leave the hidden one out.
    const later = receiveRecord(
      pressed,
      record("2999", {
        sentThrough: 4,
        items: [message("m2", 2), message("m3", 3), message("m4", 4)],
      }),
    );
    expect(waitingWriterMessages(later).map((i) => i.id)).toEqual(["m3", "m4"]);
    // A failed request shows them again, still queued.
    const failed = addIntent(later, {
      kind: "handBack",
      id: "req",
      candidates,
      failed: true,
      answer: null,
    });
    expect(waitingWriterMessages(failed).map((i) => i.id)).toEqual(["m2", "m3", "m4"]);
    // The answer retires it once the record is at or past the answer.
    const answered = answerIntent(later, "handBack", "req", "3999");
    expect(hiddenWriterTurns(answered).size).toBe(2);
    expect(hiddenWriterTurns(receiveRecord(answered, record("3999"))).size).toBe(0);
  });
});
