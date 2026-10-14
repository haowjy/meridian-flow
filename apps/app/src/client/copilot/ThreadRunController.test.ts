/** Controller recovery fences, the run-follow scenario on a live stream, and gap recovery ownership. */
import {
  type AdmissionLookup,
  EventType,
  type RetireAdmissionResult,
  type SendMessageResponse,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultSendResponse,
  scenarioGate,
  snapshotResponse,
  snapshotTurn,
  ThreadRunScenario,
  writerPendingItem,
} from "./test-support/ThreadRunScenario";

const scenarios: ThreadRunScenario[] = [];

function makeScenario(...args: ConstructorParameters<typeof ThreadRunScenario>) {
  const mounted = new ThreadRunScenario(...args);
  scenarios.push(mounted);
  return mounted;
}

afterEach(() => {
  try {
    for (const mounted of scenarios) mounted.controller.dispose();
  } finally {
    scenarios.length = 0;
    vi.useRealTimers();
  }
});

describe("ThreadRunController write outcomes", () => {
  it("stops following an owed message when deletion leaves its chat pane", async () => {
    const scenario = makeScenario();
    await scenario.submit("owed behind a switch");
    expect(scenario.controller.runFollowStatus("thread_1").following).toBe(true);
    scenario.controller.teardown("thread_1");
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual({
      following: false,
      waiting: false,
    });
    expect(scenario.activeSubscription()).toBeUndefined();
  });

  it("does not revive old recovery or submission after reactivating the same session object", async () => {
    const lookup = scenarioGate<AdmissionLookup>();
    const append = scenarioGate<SendMessageResponse>();
    const scenario = makeScenario({
      lookup: () => lookup.promise,
      append: () => append.promise,
    });
    const session = {};
    scenario.controller.beginRecoverySession(session);
    const row = scenario.store
      .getState()
      .appendUserTurn("thread_1", [{ type: "text", text: "hello" }]);
    const recovered = scenario.controller.lookupSubmission(
      "thread_1",
      "sub-1",
      { signal: new AbortController().signal, optimisticUserTurnId: row.id },
      session,
    );
    const submitted = scenario.submit("hello");
    scenario.controller.dispose();
    scenario.controller.activate();
    scenario.controller.beginRecoverySession(session);
    lookup.resolve({
      kind: "already-accepted",
      threadId: "thread_1",
      submissionId: "sub-1",
      userTurnId: "turn-user",
      steersTurnId: "turn-assistant",
      runStateVersion: null,
      resumeAfterSeq: "42",
      snapshotFloorNextSeq: "43",
    });
    append.resolve(defaultSendResponse());
    await expect(recovered).resolves.toMatchObject({ kind: "abandoned" });
    await expect(submitted).resolves.toMatchObject({ kind: "abandoned" });
    expect(scenario.activeSubscription()).toBeUndefined();
    scenario.controller.dispose();
  });

  it("does not acknowledge or start a run when a recovery retire settles after its session ends", async () => {
    const gate = scenarioGate<RetireAdmissionResult>();
    const scenario = makeScenario({ retire: () => gate.promise });
    const session = {};
    scenario.controller.beginRecoverySession(session);
    const row = scenario.store
      .getState()
      .appendUserTurn("thread_1", [{ type: "text", text: "Hello" }]);
    const pending = scenario.controller.retireSubmission(
      "thread_1",
      "sub-1",
      { signal: new AbortController().signal, optimisticUserTurnId: row.id },
      session,
    );
    await vi.waitFor(() => expect(scenario.retireRequests).toHaveLength(1));

    scenario.controller.endRecoverySession(session);
    gate.resolve({
      kind: "already-accepted",
      threadId: "thread_1",
      submissionId: "sub-1",
      userTurnId: "turn-user",
      steersTurnId: "turn-assistant",
      runStateVersion: null,
      resumeAfterSeq: "42",
      snapshotFloorNextSeq: "43",
    });

    await expect(pending).resolves.toMatchObject({ kind: "abandoned" });
    expect(scenario.turns()).toEqual([expect.objectContaining({ id: row.id, status: "pending" })]);
    expect(scenario.activeSubscription()).toBeUndefined();
  });

  it("keeps sibling recovery sessions independent when one ends", async () => {
    const scenario = makeScenario({
      lookup: async ({ submissionId }) => ({
        kind: "already-accepted",
        threadId: "thread_1",
        submissionId,
        userTurnId: `turn-${submissionId}`,
        runStateVersion: null,
        steersTurnId: `assistant-${submissionId}`,
        resumeAfterSeq: "42",
        snapshotFloorNextSeq: "43",
      }),
    });
    const ended = {};
    const sibling = {};
    scenario.controller.beginRecoverySession(ended);
    scenario.controller.beginRecoverySession(sibling);
    scenario.controller.endRecoverySession(ended);

    const endedRow = scenario.store
      .getState()
      .appendUserTurn("thread_1", [{ type: "text", text: "Ended" }]);
    await expect(
      scenario.controller.lookupSubmission(
        "thread_1",
        "sub-ended",
        { signal: new AbortController().signal, optimisticUserTurnId: endedRow.id },
        ended,
      ),
    ).resolves.toMatchObject({ kind: "abandoned" });

    // The sibling token still owns its own reconciliation and settles normally.
    const siblingRow = scenario.store
      .getState()
      .appendUserTurn("thread_1", [{ type: "text", text: "Sibling" }]);
    await expect(
      scenario.controller.lookupSubmission(
        "thread_1",
        "sub-sibling",
        { signal: new AbortController().signal, optimisticUserTurnId: siblingRow.id },
        sibling,
      ),
    ).resolves.toMatchObject({ kind: "accepted" });

    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: endedRow.id, status: "pending" }),
      expect.objectContaining({ id: "turn-sub-sibling", status: "complete" }),
    ]);
  });
});

/** A reply start as the server projects it: its execution and the messages it was reserved for. */
function runStarted(
  runId: string,
  executionId: string,
  reservedFor: string[] = [],
  position: number | null = null,
) {
  return {
    type: EventType.RUN_STARTED,
    threadId: "thread_1",
    runId,
    rawEvent: { writeMode: "direct", executionId, reservedForUserTurnIds: reservedFor, position },
  } as never;
}

function runFinished(runId: string) {
  return { type: EventType.RUN_FINISHED, threadId: "thread_1", runId } as never;
}

function textDelta(messageId: string, delta: string) {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta } as never;
}

function textStart(messageId: string) {
  return { type: EventType.TEXT_MESSAGE_START, messageId } as never;
}

function delivered(byTurnId: string, executionId: string, userTurnIds: string[]) {
  return {
    type: EventType.CUSTOM,
    name: "meridian.messages.delivered",
    value: { byTurnId, executionId, userTurnIds },
  } as never;
}

function executionEnded(executionId: string) {
  return {
    type: EventType.CUSTOM,
    name: "meridian.execution.ended",
    value: { executionId },
  } as never;
}

/** The chat's pending inbox frame: the writer messages still owed. */
function inbox(...writerMessages: string[]) {
  return {
    type: EventType.CUSTOM,
    name: "meridian.inbox.changed",
    value: { items: writerMessages.map(writerPendingItem) },
  } as never;
}

function textOf(scenario: ThreadRunScenario, turnId: string) {
  return scenario
    .turns()
    .find((turn) => turn.id === turnId)
    ?.blocks.map((block) => block.textContent ?? "")
    .join("");
}

describe("ThreadRunController follows run identity", () => {
  it("I1: a message steered into A, then queued behind a switch, follows B through a gap", async () => {
    const scenario = makeScenario({
      append: async () =>
        defaultSendResponse({ userTurnId: "m1", steersTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("M1");
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual({
      following: true,
      waiting: true,
    });
    scenario.emit(inbox("m1"), "11");
    scenario.emit(runStarted("a", "e1", ["m1"]), "12");
    scenario.emit(textStart("text-a"), "13");
    scenario.emit(textDelta("text-a", "A says"), "14");
    scenario.emit(delivered("a", "e1", ["m1"]), "15");
    scenario.emit(inbox(), "16");
    expect(textOf(scenario, "a")).toBe("A says");

    // M2 is steered into A; a queued switch then makes A yield without taking it on.
    scenario.setAppend(async () =>
      defaultSendResponse({ userTurnId: "m2", steersTurnId: "a", resumeAfterSeq: "16" }),
    );
    await scenario.submit("M2");
    scenario.emit(inbox("m2"), "17");
    scenario.emit(runFinished("a"), "18");
    scenario.emit(executionEnded("e1"), "19");
    // E1 ended with M2 undelivered: still owed, so the chat keeps Stop.
    expect(scenario.activeSubscription()?.active).toBe(true);
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual({
      following: true,
      waiting: true,
    });
    scenario.transport.cancelStatus = "already_finished";
    scenario.controller.cancel("thread_1");
    await vi.waitFor(() =>
      expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "a" }]),
    );

    // A gap swallows the switch and B's start; the snapshot shows B in E2.
    scenario.transport.cancelStatus = "cancelled";
    scenario.setSnapshot(async () =>
      snapshotResponse({
        turns: [
          snapshotTurn("m1", "user", { deliveredBy: "a" }),
          snapshotTurn("a", "assistant", { executionId: "e1", reservedFor: ["m1"] }),
          snapshotTurn("m2", "user"),
          snapshotTurn("switch", "system"),
          snapshotTurn("b", "assistant", {
            executionId: "e2",
            reservedFor: ["m2"],
            status: "streaming",
          }),
        ],
        openExecutionId: "e2",
        runningTurnId: "b",
        pendingWriterMessages: ["m2"],
      }),
    );
    scenario.reportGap();
    // The Stop that A refused lands on B, which took M2 on.
    await vi.waitFor(() =>
      expect(scenario.transport.cancelRequests).toEqual([
        { threadId: "thread_1", turnId: "a" },
        { threadId: "thread_1", turnId: "b" },
      ]),
    );
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual({
      following: true,
      waiting: false,
    });
    scenario.emit(textStart("text-b"), "100");
    scenario.emit(textDelta("text-b", "B answers"), "101");
    scenario.controller.flushPendingDeltas("thread_1");
    expect(textOf(scenario, "b")).toBe("B answers");

    scenario.emit(delivered("b", "e2", ["m2"]), "102");
    scenario.emit(inbox(), "103");
    scenario.emit(runFinished("b"), "104");
    expect(scenario.activeSubscription()?.active).toBe(true);
    scenario.emit(executionEnded("e2"), "105");
    expect(scenario.activeSubscription()).toBeUndefined();
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual({
      following: false,
      waiting: false,
    });
    expect(scenario.turns().find((turn) => turn.id === "b")?.status).toBe("complete");
  });
});

describe("controller gap-result ownership", () => {
  it("does not apply a gap response after its run terminates", async () => {
    vi.useFakeTimers();
    const gate = scenarioGate<ThreadSnapshotResponse>();
    const scenario = makeScenario({ snapshot: () => gate.promise });
    scenario.attach({ runningTurnId: "run-1" });
    scenario.emit(runStarted("run-1", "exec-1"), "10");
    scenario.reportGap();
    expect(scenario.snapshotRequests).toEqual(["thread_1"]);
    scenario.emit(runFinished("run-1"), "11");
    scenario.emit(executionEnded("exec-1"), "12");
    await vi.waitFor(() => expect(scenario.activeSubscription()).toBeUndefined());
    const terminal = scenario.turns()[0];
    gate.resolve(snapshotResponse({ turns: [], openExecutionId: null }));
    await gate.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(scenario.turns()[0]).toBe(terminal);
    expect(scenario.turns()).toHaveLength(1);
  });

  it("retries a stale gap snapshot instead of treating HTTP success as recovery", async () => {
    vi.useFakeTimers();
    let nextSeq = "4000";
    const scenario = makeScenario({
      snapshot: async () => snapshotResponse({ turns: [], openExecutionId: null, nextSeq }),
    });
    scenario.store.getState().acceptDurableBlockSeq("thread_1", "4000");
    scenario.attach({ runningTurnId: "run-1" });
    scenario.emit(runStarted("run-1", "exec-1"), "10");
    scenario.reportGap();
    await vi.advanceTimersByTimeAsync(500);
    expect(scenario.store.getState().durableBlockCursorByThread.thread_1).toBe("4000");
    nextSeq = "5000";
    await vi.advanceTimersByTimeAsync(1000);
    expect(scenario.snapshotRequests.length).toBeLessThanOrEqual(6);
    expect(scenario.store.getState().durableBlockCursorByThread.thread_1).toBe("4999");
    expect(scenario.activeSubscription()).toBeDefined();
    scenario.emit(runFinished("run-1"), "5001");
    expect(scenario.turns()[0]?.status).toBe("complete");
  });

  it("aborts unresolved gap requests on teardown and disposal", () => {
    const scenario = makeScenario({
      snapshot: () => new Promise(() => undefined),
    });
    scenario.attach({ runningTurnId: "run-1" });
    scenario.reportGap();
    expect(scenario.snapshotSignals).toHaveLength(1);
    expect(scenario.snapshotSignals[0]?.aborted).toBe(false);
    scenario.controller.teardown("thread_1");
    expect(scenario.snapshotSignals[0]?.aborted).toBe(true);
    scenario.attach({ executionId: "exec-2", runningTurnId: "run-2" });
    scenario.reportGap();
    expect(scenario.snapshotSignals).toHaveLength(2);
    expect(scenario.snapshotSignals[1]?.aborted).toBe(false);
    scenario.controller.dispose();
    expect(scenario.snapshotSignals[1]?.aborted).toBe(true);
  });

  it("keeps real gap network errors on the existing run-failure path", async () => {
    const scenario = makeScenario({
      snapshot: async () => {
        throw new Error("offline");
      },
    });
    scenario.attach({ runningTurnId: "run-1" });
    scenario.emit(runStarted("run-1", "exec-1"), "10");
    scenario.reportGap();
    await vi.waitFor(() => expect(scenario.activeSubscription()).toBeUndefined());
    expect(scenario.snapshotRequests).toHaveLength(1);
  });

  it("starts fresh recovery when a newer follow joined an older singleton fetch", async () => {
    const old = scenarioGate<ThreadSnapshotResponse>();
    const fresh = scenarioGate<ThreadSnapshotResponse>();
    let requests = 0;
    const scenario = makeScenario({
      snapshot: () => (++requests === 1 ? old.promise : fresh.promise),
    });
    scenario.attach({ runningTurnId: "run-1" });
    scenario.emit(runStarted("run-1", "exec-1"), "10");
    scenario.reportGap();
    scenario.controller.teardown("thread_1");
    scenario.attach({ executionId: "exec-2", runningTurnId: "run-2" });
    scenario.emit(runStarted("run-2", "exec-2"), "20");
    scenario.reportGap();
    old.resolve(snapshotResponse({ turns: [], openExecutionId: null, nextSeq: "30" }));
    await vi.waitFor(() => expect(scenario.snapshotRequests).toEqual(["thread_1", "thread_1"]));
    fresh.resolve(snapshotResponse({ turns: [], openExecutionId: null, nextSeq: "31" }));
    await fresh.promise;
  });
});

describe("controller stream routing is fenced by seq", () => {
  /** A snapshot read while unrelated A/E1 ran, before B started for M2. */
  function preBSnapshot() {
    return snapshotResponse({
      turns: [
        snapshotTurn("a", "assistant", {
          executionId: "e1",
          status: "streaming",
          reservedFor: ["m1"],
        }),
        snapshotTurn("m2", "user"),
      ],
      openExecutionId: "e1",
      runningTurnId: "a",
      pendingWriterMessages: ["m2"],
      resumeAfterSeq: "100",
      nextSeq: "101",
    });
  }

  function owedM2ThenBStarts(scenario: ThreadRunScenario) {
    scenario.controller.observePending("thread_1", { items: [writerPendingItem("m2")] }, "100");
    scenario.emit(executionEnded("e1"), "105");
    scenario.emit(runStarted("b", "e2", ["m2"]), "110");
  }

  it("a delayed mounted snapshot does not move deltas off the newer B", () => {
    const scenario = makeScenario();
    owedM2ThenBStarts(scenario);
    scenario.controller.observeSnapshot("thread_1", preBSnapshot());
    scenario.emit(textStart("text-b"), "111");
    scenario.emit(textDelta("text-b", "B output"), "112");
    scenario.controller.flushPendingDeltas("thread_1");
    expect(textOf(scenario, "b")).toBe("B output");
  });

  it("an explicit gap snapshot older than B's start does not move deltas off B", async () => {
    const scenario = makeScenario({ snapshot: async () => preBSnapshot() });
    owedM2ThenBStarts(scenario);
    scenario.reportGap();
    // The gap snapshot is applied (A appears) before B's text arrives.
    await vi.waitFor(() => expect(scenario.turns().some((turn) => turn.id === "a")).toBe(true));
    scenario.emit(textStart("text-b"), "111");
    scenario.emit(textDelta("text-b", "B output"), "112");
    scenario.controller.flushPendingDeltas("thread_1");
    expect(textOf(scenario, "b")).toBe("B output");
  });

  it("a newer snapshot still routes deltas to the reply it shows running", () => {
    const scenario = makeScenario();
    scenario.controller.observePending("thread_1", { items: [writerPendingItem("m2")] }, "100");
    scenario.emit(runStarted("a", "e1", ["m2"]), "101");
    scenario.emit(runFinished("a"), "102");
    scenario.controller.observeSnapshot(
      "thread_1",
      snapshotResponse({
        turns: [
          snapshotTurn("a", "assistant", { executionId: "e1", reservedFor: ["m2"] }),
          snapshotTurn("b", "assistant", {
            executionId: "e1",
            status: "streaming",
            reservedFor: ["m2"],
          }),
        ],
        openExecutionId: "e1",
        runningTurnId: "b",
        pendingWriterMessages: ["m2"],
        resumeAfterSeq: "120",
      }),
    );
    scenario.emit(textStart("text-b"), "121");
    scenario.emit(textDelta("text-b", "B output"), "122");
    scenario.controller.flushPendingDeltas("thread_1");
    expect(textOf(scenario, "b")).toBe("B output");
  });
});

describe("case 9: an ordinary steer, then Stop of the successor", () => {
  it("keeps A's final line after the steer and routes Stop to the successor", async () => {
    const scenario = makeScenario({
      append: async () =>
        defaultSendResponse({ userTurnId: "m1", steersTurnId: null, resumeAfterSeq: "74999" }),
    });
    await scenario.submit("ORDINARY");
    scenario.emit(inbox("m1"), "75001");
    scenario.emit(runStarted("a", "x", ["m1"], 8), "78000");
    scenario.emit(textStart("a:0"), "79000");
    scenario.emit(textDelta("a:0", "Ordinary first"), "79001");
    scenario.emit(delivered("a", "x", ["m1"]), "87000");
    scenario.emit(inbox(), "88000");
    scenario.setAppend(async () =>
      defaultSendResponse({ userTurnId: "m2", steersTurnId: "a", resumeAfterSeq: "93999" }),
    );
    await scenario.submit("STEER");
    scenario.emit(inbox("m2"), "94001");
    // The mounted owner's refresh for that inbox frame lands while A still runs.
    scenario.controller.observeSnapshot(
      "thread_1",
      snapshotResponse({
        turns: [
          snapshotTurn("m1", "user", { deliveredBy: "a", position: 7 }),
          snapshotTurn("a", "assistant", {
            executionId: "x",
            reservedFor: ["m1"],
            status: "streaming",
          }),
          snapshotTurn("m2", "user"),
        ],
        openExecutionId: "x",
        runningTurnId: "a",
        pendingWriterMessages: ["m2"],
        resumeAfterSeq: "94999",
        nextSeq: "95000",
      }),
    );
    scenario.emit(textStart("a:3"), "95000");
    scenario.emit(textDelta("a:3", "ordinary boundary"), "95001");
    scenario.emit(runFinished("a"), "102000");
    scenario.emit(runStarted("b", "x", ["m2"], 10), "103000");
    scenario.controller.flushPendingDeltas("thread_1");
    expect(textOf(scenario, "a")).toContain("ordinary boundary");

    scenario.controller.cancel("thread_1");
    await vi.waitFor(() =>
      expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "b" }]),
    );
    scenario.emit(delivered("b", "x", ["m2"]), "108000");
    scenario.emit(executionEnded("x"), "109000");
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual({
      following: false,
      waiting: false,
    });
    expect(textOf(scenario, "a")).toContain("ordinary boundary");
  });
});

describe("TL-D62-m: admission's obligation overlay", () => {
  const FOLLOWING = { following: true, waiting: false };
  const WAITING = { following: true, waiting: true };
  const SETTLED = { following: false, waiting: false };

  it("keeps an admitted message owed until its delayed inbox frame and delivery arrive", async () => {
    const scenario = makeScenario({
      append: async () =>
        defaultSendResponse({ userTurnId: "m1", steersTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("M1");
    // The replay from the admission cursor ends the previous execution before
    // the frame that shows M1: the overlay keeps the chat waiting.
    scenario.emit(executionEnded("e0"), "11");
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual(WAITING);
    expect(scenario.activeSubscription()?.active).toBe(true);
    scenario.emit(inbox("m1"), "12");
    scenario.emit(runStarted("b", "e1", ["m1"], 2), "13");
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual(FOLLOWING);
    scenario.emit(delivered("b", "e1", ["m1"]), "14");
    scenario.emit(inbox(), "15");
    scenario.emit(executionEnded("e1"), "16");
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual(SETTLED);
  });

  it("does not re-owe a message whose accepted answer is replayed after its delivery", async () => {
    const append = scenarioGate<SendMessageResponse>();
    const scenario = makeScenario({ append: () => append.promise });
    const submitted = scenario.submit("M1");
    // Another tab's projection shows M1, and its execution delivers and ends,
    // before this tab's admission answer arrives.
    scenario.controller.observePending("thread_1", { items: [writerPendingItem("m1")] }, "11");
    scenario.emit(runStarted("b", "e1", ["m1"], 2), "12");
    scenario.emit(delivered("b", "e1", ["m1"]), "13");
    scenario.emit(inbox(), "14");
    scenario.emit(executionEnded("e1"), "15");
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual(SETTLED);
    append.resolve(
      defaultSendResponse({ userTurnId: "m1", steersTurnId: null, resumeAfterSeq: "10" }),
    );
    await expect(submitted).resolves.toMatchObject({ kind: "accepted" });
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual(SETTLED);
    expect(scenario.activeSubscription()).toBeUndefined();
  });
});

describe("run facts subscribers", () => {
  it("are told when only the facts change, and not by a snapshot that adds nothing", () => {
    const scenario = makeScenario();
    const listener = vi.fn();
    const unsubscribe = scenario.controller.subscribeRunFollow(listener);
    const snapshot = snapshotResponse({
      turns: [snapshotTurn("c", "compaction", { executionId: "e-r", status: "cancelled" })],
      openExecutionId: null,
    });
    scenario.controller.observeSnapshot("thread_1", snapshot);
    expect(scenario.controller.runFollowStatus("thread_1")).toEqual({
      following: false,
      waiting: false,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    const facts = scenario.controller.runFacts("thread_1");
    expect(facts.ended.has("e-r")).toBe(true);

    scenario.controller.observeSnapshot("thread_1", snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(scenario.controller.runFacts("thread_1")).toBe(facts);
    unsubscribe();
  });
});
