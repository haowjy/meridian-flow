/** Controller recovery fences and mid-run queue admission subscription continuity. */
import {
  type AdmissionLookup,
  EventType,
  type RetireAdmissionResult,
  type SendMessageResponse,
} from "@meridian/contracts/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultSendResponse,
  scenarioGate,
  ThreadRunScenario,
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
  it("does not revive old recovery or submission after reactivating the same session object", async () => {
    const lookup = scenarioGate<AdmissionLookup>();
    const append = scenarioGate<SendMessageResponse>();
    const scenario = makeScenario({
      lookup: () => lookup.promise,
      append: () => append.promise,
    });
    const session = {};
    scenario.controller.beginRecoverySession(session);
    const recovered = scenario.controller.lookupSubmission("thread_1", "sub-1", {}, session);
    const submitted = scenario.submit("hello");
    scenario.controller.dispose();
    scenario.controller.activate();
    scenario.controller.beginRecoverySession(session);
    lookup.resolve({
      kind: "already-accepted",
      threadId: "thread_1",
      submissionId: "sub-1",
      userTurnId: "turn-user",
      assistantTurnId: "turn-assistant",
      resumeAfterSeq: "42",
      snapshotFloorNextSeq: "43",
    });
    append.resolve(defaultSendResponse());
    await expect(recovered).resolves.toMatchObject({ kind: "ambiguous" });
    await expect(submitted).resolves.toMatchObject({ kind: "ambiguous" });
    expect(scenario.activeSubscription()).toBeUndefined();
    scenario.controller.dispose();
  });

  it("does not acknowledge or start a run when a recovery retire settles after its session ends", async () => {
    const gate = scenarioGate<RetireAdmissionResult>();
    const scenario = makeScenario({ retire: () => gate.promise });
    const session = {};
    scenario.controller.beginRecoverySession(session);
    const row = scenario.store.getState().appendUserTurn("thread_1", "Hello");
    const pending = scenario.controller.retireSubmission(
      "thread_1",
      "sub-1",
      { optimisticUserTurnId: row.id },
      session,
    );
    await vi.waitFor(() => expect(scenario.retireRequests).toHaveLength(1));

    scenario.controller.endRecoverySession(session);
    gate.resolve({
      kind: "already-accepted",
      threadId: "thread_1",
      submissionId: "sub-1",
      userTurnId: "turn-user",
      assistantTurnId: "turn-assistant",
      resumeAfterSeq: "42",
      snapshotFloorNextSeq: "43",
    });

    await expect(pending).resolves.toMatchObject({ kind: "ambiguous" });
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
        assistantTurnId: `assistant-${submissionId}`,
        resumeAfterSeq: "42",
        snapshotFloorNextSeq: "43",
      }),
    });
    const ended = {};
    const sibling = {};
    scenario.controller.beginRecoverySession(ended);
    scenario.controller.beginRecoverySession(sibling);
    scenario.controller.endRecoverySession(ended);

    const endedRow = scenario.store.getState().appendUserTurn("thread_1", "Ended");
    await expect(
      scenario.controller.lookupSubmission(
        "thread_1",
        "sub-ended",
        { optimisticUserTurnId: endedRow.id },
        ended,
      ),
    ).resolves.toMatchObject({ kind: "ambiguous" });

    // The sibling token still owns its own reconciliation and settles normally.
    const siblingRow = scenario.store.getState().appendUserTurn("thread_1", "Sibling");
    await expect(
      scenario.controller.lookupSubmission(
        "thread_1",
        "sub-sibling",
        { optimisticUserTurnId: siblingRow.id },
        sibling,
      ),
    ).resolves.toMatchObject({ kind: "accepted" });

    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: endedRow.id, status: "pending" }),
      expect.objectContaining({ id: "turn-sub-sibling", status: "complete" }),
    ]);
  });
});

function runStarted(runId: string) {
  return { type: EventType.RUN_STARTED, threadId: "thread_1", runId } as never;
}

describe("ThreadRunController mid-run merge", () => {
  it("keeps the live subscription instead of rewinding on a merge", async () => {
    const scenario = makeScenario({
      append: async () => defaultSendResponse({ assistantTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("hello");
    expect(scenario.transport.subscriptions).toHaveLength(1);
    scenario.emit(runStarted("run-1"), "11");

    scenario.setAppend(async () =>
      defaultSendResponse({ assistantTurnId: "run-1", resumeAfterSeq: "11" }),
    );
    await scenario.submit("steer");

    expect(scenario.transport.subscriptions).toHaveLength(1);
    expect(scenario.transport.activeSubscription()?.active).toBe(true);
  });

  it("starts a fresh subscription for a fresh run", async () => {
    const scenario = makeScenario({
      append: async () => defaultSendResponse({ assistantTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("hello");
    scenario.emit(runStarted("run-1"), "11");

    await scenario.submit("again");

    expect(scenario.transport.subscriptions).toHaveLength(2);
  });

  it("keeps one mounted stream across a server-initiated split turn", async () => {
    const scenario = makeScenario({
      append: async () => defaultSendResponse({ assistantTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("long request");
    scenario.emit(runStarted("turn-a"), "11");
    scenario.emit(
      { type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "turn-a" } as never,
      "12",
    );
    expect(scenario.activeSubscription()?.active).toBe(true);

    scenario.emit(runStarted("turn-b"), "13");
    expect(scenario.transport.subscriptions).toHaveLength(1);
    expect(scenario.activeSubscription()?.active).toBe(true);
    expect(scenario.turns().map(({ id }) => id)).toEqual(["turn-a", "turn-b"]);

    scenario.emit(
      { type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "turn-b" } as never,
      "14",
    );
    await vi.waitFor(() => expect(scenario.activeSubscription()).toBeUndefined());
  });
});

describe("controller gap-result ownership", () => {
  it("does not apply a gap response after its run terminates", async () => {
    vi.useFakeTimers();
    const gate = scenarioGate<import("@meridian/contracts/protocol").ThreadSnapshotResponse>();
    const scenario = makeScenario({ snapshot: () => gate.promise });
    scenario.resume({ expectedTurnId: "run-1" });
    scenario.emit(runStarted("run-1"), "10");
    scenario.reportGap();
    expect(scenario.snapshotRequests).toEqual(["thread_1"]);
    scenario.emit(
      { type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "run-1" } as never,
      "11",
    );
    await vi.waitFor(() => expect(scenario.activeSubscription()).toBeUndefined());
    const terminal = scenario.turns()[0];
    gate.resolve({
      thread: { id: "thread_1", projectId: "project-1", userId: "account-1" },
      turns: [],
      nextSeq: "100",
      actionRequired: false,
      liveState: { runningTurnId: null },
    } as never);
    await gate.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(scenario.turns()[0]).toBe(terminal);
    expect(scenario.turns()).toHaveLength(1);
  });

  it("retries a stale gap snapshot instead of treating HTTP success as recovery", async () => {
    vi.useFakeTimers();
    const gates = [
      scenarioGate<import("@meridian/contracts/protocol").ThreadSnapshotResponse>(),
      scenarioGate<import("@meridian/contracts/protocol").ThreadSnapshotResponse>(),
      scenarioGate<import("@meridian/contracts/protocol").ThreadSnapshotResponse>(),
    ];
    let request = 0;
    const nextSnapshot = () => {
      const gate = gates[request++];
      if (!gate) throw new Error("Unexpected gap snapshot request");
      return gate.promise;
    };
    const resolve = (index: number, nextSeq: string) => {
      const gate = gates[index];
      if (!gate) throw new Error(`Missing snapshot gate ${index}`);
      gate.resolve(snapshot(nextSeq));
    };
    const snapshot = (nextSeq: string) =>
      ({
        threadId: "thread_1",
        thread: { id: "thread_1", userId: "account-1" },
        turns: [],
        nextSeq,
        actionRequired: false,
        liveState: { runningTurnId: null },
      }) as unknown as import("@meridian/contracts/protocol").ThreadSnapshotResponse;
    const scenario = makeScenario({
      snapshot: nextSnapshot,
    });
    scenario.store.getState().acceptDurableBlockSeq("thread_1", "4000");
    scenario.resume({ expectedTurnId: "run-1" });
    scenario.emit(runStarted("run-1"), "10");
    scenario.reportGap();
    expect(scenario.snapshotRequests).toHaveLength(1);
    resolve(0, "4000");
    await vi.advanceTimersByTimeAsync(250);
    expect(scenario.snapshotRequests).toHaveLength(2);
    resolve(1, "4000");
    await vi.advanceTimersByTimeAsync(250);
    expect(scenario.snapshotRequests).toHaveLength(3);
    resolve(2, "5000");
    await vi.advanceTimersByTimeAsync(0);
    expect(scenario.store.getState().durableBlockCursorByThread.thread_1).toBe("4999");
    expect(scenario.activeSubscription()).toBeDefined();
    scenario.emit(
      { type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "run-1" } as never,
      "5001",
    );
    expect(scenario.turns()[0]?.status).toBe("complete");
  });

  it("stops outstanding stale recovery on disposal without another fetch", async () => {
    vi.useFakeTimers();
    const gate = scenarioGate<import("@meridian/contracts/protocol").ThreadSnapshotResponse>();
    const scenario = makeScenario({ snapshot: () => gate.promise });
    scenario.store.getState().acceptDurableBlockSeq("thread_1", "4000");
    scenario.resume({ expectedTurnId: "run-1" });
    scenario.emit(runStarted("run-1"), "10");
    scenario.reportGap();
    expect(scenario.snapshotRequests).toHaveLength(1);
    scenario.controller.dispose();
    gate.resolve({
      thread: { id: "thread_1", userId: "account-1" },
      turns: [],
      nextSeq: "4000",
      actionRequired: false,
      liveState: { runningTurnId: null },
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(scenario.snapshotRequests).toHaveLength(1);
    expect(scenario.activeSubscription()).toBeUndefined();
  });

  it("aborts unresolved gap requests on run replacement and disposal", () => {
    const scenario = makeScenario({
      snapshot: () => new Promise(() => undefined),
    });
    scenario.resume({ expectedTurnId: "run-1" });
    scenario.reportGap();
    expect(scenario.snapshotSignals).toHaveLength(1);
    expect(scenario.snapshotSignals[0]?.aborted).toBe(false);
    scenario.resume({ expectedTurnId: "run-2" });
    expect(scenario.snapshotSignals[0]?.aborted).toBe(true);
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
    scenario.resume({ expectedTurnId: "run-1" });
    scenario.emit(runStarted("run-1"), "10");
    scenario.reportGap();
    await vi.waitFor(() => expect(scenario.activeSubscription()).toBeUndefined());
    expect(scenario.snapshotRequests).toHaveLength(1);
  });

  it("retries a mismatched gap response instead of satisfying recovery", async () => {
    vi.useFakeTimers();
    const first = scenarioGate<import("@meridian/contracts/protocol").ThreadSnapshotResponse>();
    const second = scenarioGate<import("@meridian/contracts/protocol").ThreadSnapshotResponse>();
    let request = 0;
    const scenario = makeScenario({
      snapshot: () => (request++ === 0 ? first.promise : second.promise),
    });
    scenario.resume({ expectedTurnId: "run-1" });
    scenario.emit(runStarted("run-1"), "10");
    scenario.reportGap();
    first.resolve({
      thread: { id: "other-thread", userId: "account-1" },
      turns: [],
      nextSeq: "5000",
      actionRequired: false,
      liveState: { runningTurnId: null },
    } as never);
    await vi.advanceTimersByTimeAsync(250);
    expect(scenario.snapshotRequests).toHaveLength(2);
    second.resolve({
      thread: { id: "thread_1", userId: "account-1" },
      turns: [],
      nextSeq: "5000",
      actionRequired: false,
      liveState: { runningTurnId: null },
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(scenario.store.getState().durableBlockCursorByThread.thread_1).toBe("4999");
  });

  it("starts fresh recovery when a newer run joined an older singleton fetch", async () => {
    const old = scenarioGate<import("@meridian/contracts/protocol").ThreadSnapshotResponse>();
    const fresh = scenarioGate<import("@meridian/contracts/protocol").ThreadSnapshotResponse>();
    let requests = 0;
    const scenario = makeScenario({
      snapshot: () => (++requests === 1 ? old.promise : fresh.promise),
    });
    scenario.resume({ expectedTurnId: "run-1" });
    scenario.emit(runStarted("run-1"), "10");
    scenario.reportGap();
    scenario.resume({ expectedTurnId: "run-2" });
    scenario.emit(runStarted("run-2"), "20");
    scenario.reportGap();
    old.resolve({
      thread: { id: "thread_1", userId: "account-1" },
      turns: [],
      nextSeq: "30",
      actionRequired: false,
      liveState: { runningTurnId: null },
    } as never);
    await vi.waitFor(() => expect(scenario.snapshotRequests).toEqual(["thread_1", "thread_1"]));
    fresh.resolve({
      thread: { id: "thread_1", userId: "account-1" },
      turns: [],
      nextSeq: "31",
      actionRequired: false,
      liveState: { runningTurnId: null },
    } as never);
    await fresh.promise;
  });
});
