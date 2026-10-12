/** Controller recovery fences and mid-run queue admission subscription continuity. */
import {
  type AdmissionLookup,
  EventType,
  type RetireAdmissionResult,
  type SendMessageResponse,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import { goldenAssistantTurn } from "@meridian/contracts/threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toThreadSnapshotApplyOptions } from "@/client/api/threads-api";
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

/** The replies the store shows; a send's own user row is not what these tests follow. */
function assistantTurnIds(scenario: { turns(): readonly { id: string; role: string }[] }) {
  return scenario
    .turns()
    .filter(({ role }) => role === "assistant")
    .map(({ id }) => id);
}

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
      assistantTurnId: "turn-assistant",
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
      assistantTurnId: "turn-assistant",
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

/** A reply start as the server projects it: the user turns it answers and the reply it continues. */
function runStarted(
  runId: string,
  answersUserTurnIds: string[] = [],
  continuesRunId: string | null = null,
) {
  return {
    type: EventType.RUN_STARTED,
    threadId: "thread_1",
    runId,
    rawEvent: { writeMode: "direct", answersUserTurnIds, continuesRunId },
  } as never;
}

/** A reply finish; `continued` when its lease reserved a successor. */
function runFinished(runId: string, continued = false) {
  return {
    type: EventType.RUN_FINISHED,
    threadId: "thread_1",
    runId,
    rawEvent: { continued },
  } as never;
}

function snapshotTurn(
  id: string,
  role: "user" | "assistant" | "system",
  position: number,
  prevTurnId: string | null,
  status: "complete" | "streaming" | "error" = "complete",
) {
  return { ...goldenAssistantTurn(id, "thread_1", status), role, position, prevTurnId };
}

function snapshotOf(
  turns: ReturnType<typeof snapshotTurn>[],
  runningTurnId: string | null = null,
): ThreadSnapshotResponse {
  return {
    threadId: "thread_1",
    thread: { id: "thread_1", userId: "account-1" },
    turns,
    nextSeq: "100",
    actionRequired: false,
    liveState: { runningTurnId },
  } as unknown as ThreadSnapshotResponse;
}

/** What the mounted snapshot owner hands the store before a handoff resumes. */
function applyArgs(response: ThreadSnapshotResponse) {
  return [response.thread, response.turns, toThreadSnapshotApplyOptions(response)] as const;
}

/** A reply A the controller follows, with an admission for M2 that names no reply. */
async function followAThenQueueM2(scenario: ThreadRunScenario) {
  scenario.resume({ expectedTurnId: "turn-a" });
  scenario.emit(runStarted("turn-a", ["turn-m1"]), "11");
  scenario.setAppend(async () =>
    defaultSendResponse({ userTurnId: "turn-m2", assistantTurnId: null, resumeAfterSeq: "11" }),
  );
  await scenario.submit("M2");
}

describe("ThreadRunController same-lease successor", () => {
  it("follows a steered reply into the successor that names it", async () => {
    const scenario = makeScenario({
      append: async () => defaultSendResponse({ assistantTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("long request");
    scenario.emit(runStarted("turn-a", ["turn-user"]), "11");
    scenario.setAppend(async () =>
      defaultSendResponse({ userTurnId: "turn-m2", assistantTurnId: "turn-a" }),
    );
    await scenario.submit("steer");
    scenario.emit(runFinished("turn-a", true), "12");
    expect(scenario.activeSubscription()?.active).toBe(true);
    // A is complete: Stop waits for the successor instead of cancelling A.
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests).toEqual([]);

    scenario.emit(runStarted("turn-b", ["turn-m2"], "turn-a"), "13");
    expect(scenario.transport.subscriptions).toHaveLength(1);
    expect(assistantTurnIds(scenario)).toEqual(["turn-a", "turn-b"]);
    expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "turn-b" }]);

    scenario.emit(runFinished("turn-b"), "14");
    expect(scenario.activeSubscription()).toBeUndefined();
  });

  it("follows a notice split's successor even when it answers nothing", async () => {
    const scenario = makeScenario();
    scenario.resume({ expectedTurnId: "turn-a" });
    scenario.emit(runFinished("turn-a", true), "12");
    scenario.emit(runStarted("turn-b", [], "turn-a"), "13");
    expect(assistantTurnIds(scenario)).toEqual(["turn-a", "turn-b"]);
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "turn-b" }]);
  });

  it("settles at a plain finish, so another client's next reply gets no Stop", async () => {
    const scenario = makeScenario({
      append: async () => defaultSendResponse({ assistantTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("M1");
    scenario.emit(runStarted("turn-a", ["turn-user"]), "11");
    scenario.emit(runFinished("turn-a"), "12");
    expect(scenario.activeSubscription()).toBeUndefined();

    scenario.controller.cancel("thread_1");
    scenario.emit(runStarted("turn-c", ["other-tab-m"]), "13");
    expect(scenario.transport.cancelRequests).toEqual([]);
    expect(assistantTurnIds(scenario)).toEqual(["turn-a"]);
  });

  it("ignores an unrelated reply that starts right after A while M2 waits", async () => {
    const scenario = makeScenario();
    await followAThenQueueM2(scenario);
    scenario.emit(runFinished("turn-a"), "12");
    scenario.controller.cancel("thread_1");

    // Another tab's switch applied and its message's reply C started at once.
    scenario.emit(runStarted("turn-c", ["other-tab-m"]), "13");
    scenario.emit(
      { type: EventType.TEXT_MESSAGE_START, messageId: "turn-c::0", role: "assistant" } as never,
      "14",
    );
    expect(scenario.transport.cancelRequests).toEqual([]);
    expect(assistantTurnIds(scenario)).toEqual(["turn-a"]);

    scenario.emit(runFinished("turn-c"), "15");
    scenario.emit(runStarted("turn-b", ["turn-m2"]), "16");
    expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "turn-b" }]);
  });

  it("ends a continued follow when another lease starts instead of the successor", async () => {
    const scenario = makeScenario();
    scenario.resume({ expectedTurnId: "turn-a" });
    scenario.emit(runFinished("turn-a", true), "12");
    scenario.controller.cancel("thread_1");

    scenario.emit(runStarted("turn-c", ["other-tab-m"]), "13");
    expect(scenario.transport.cancelRequests).toEqual([]);
    expect(scenario.activeSubscription()).toBeUndefined();
  });

  it("settles when a handoff resumes past the start of the reply that answered M2", async () => {
    const scenario = makeScenario();
    await followAThenQueueM2(scenario);
    scenario.emit(runFinished("turn-a"), "12");
    // The snapshot owner applied B (answering M2) before the handoff resumes
    // at a cursor that already includes B's start.
    scenario.store
      .getState()
      .applyThreadSnapshot(
        ...applyArgs(
          snapshotOf(
            [
              snapshotTurn("turn-m1", "user", 1, null),
              snapshotTurn("turn-a", "assistant", 2, "turn-m1"),
              snapshotTurn("turn-m2", "user", 3, "turn-a"),
              snapshotTurn("turn-b", "assistant", 4, "turn-m2", "streaming"),
            ],
            "turn-b",
          ),
        ),
      );
    scenario.resume({ expectedTurnId: "turn-b", after: "13" });

    scenario.emit(runFinished("turn-b"), "14");
    expect(scenario.activeSubscription()).toBeUndefined();
  });

  it("binds a Retry's reply, which names the failed reply's user turn, from a handoff", async () => {
    const scenario = makeScenario({
      append: async () =>
        defaultSendResponse({ userTurnId: "turn-m1", assistantTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("M1");
    scenario.emit(runStarted("turn-f", ["turn-m1"]), "11");
    scenario.emit({ type: EventType.RUN_ERROR, message: "provider unavailable" } as never, "12");
    expect(scenario.activeSubscription()).toBeUndefined();

    // Retry holds the chat awake before R is reserved: the handoff resumes
    // with no running id, and R's start binds and takes Stop.
    scenario.resume({ after: "12" });
    scenario.emit(runStarted("turn-r", ["turn-m1"]), "13");
    expect(assistantTurnIds(scenario)).toContain("turn-r");
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "turn-r" }]);
    scenario.emit(runFinished("turn-r"), "14");
    expect(scenario.activeSubscription()).toBeUndefined();
  });
});

describe("ThreadRunController send behind a queued switch", () => {
  it("keeps the running reply while a message it will not answer is admitted", async () => {
    const scenario = makeScenario({
      append: async () => defaultSendResponse({ assistantTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("first request");
    scenario.emit(runStarted("turn-a", ["turn-user"]), "11");
    expect(assistantTurnIds(scenario)).toEqual(["turn-a"]);

    // The server names no reply: a new one, after the switch, answers this message.
    scenario.setAppend(async () =>
      defaultSendResponse({
        userTurnId: "turn-user-2",
        assistantTurnId: null,
        resumeAfterSeq: "11",
      }),
    );
    await scenario.submit("second request");
    expect(assistantTurnIds(scenario)).toContain("turn-a");

    scenario.emit(
      { type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "turn-a" } as never,
      "12",
    );
    scenario.emit(runStarted("turn-b", ["turn-user-2"]), "13");
    expect(assistantTurnIds(scenario)).toEqual(expect.arrayContaining(["turn-a", "turn-b"]));
    expect(scenario.turns().find(({ id }) => id === "turn-a")?.status).not.toBe("streaming");
  });

  it("keeps following the running reply through queued sends, Stop, and its error", async () => {
    const scenario = makeScenario({
      append: async () => defaultSendResponse({ assistantTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("first request");
    scenario.emit(runStarted("turn-a", ["turn-user"]), "11");
    for (const [userTurnId, resumeAfterSeq] of [
      ["turn-user-2", "11"],
      ["turn-user-3", "11"],
    ]) {
      scenario.setAppend(async () =>
        defaultSendResponse({ userTurnId, assistantTurnId: null, resumeAfterSeq }),
      );
      await scenario.submit(`queued ${userTurnId}`);
    }
    // Two sends behind the switch leave A visible, and Stop still targets A.
    expect(assistantTurnIds(scenario)).toEqual(["turn-a"]);
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "turn-a" }]);

    // A's error does not end the queued sends' follow: their reply starts next.
    scenario.emit({ type: EventType.RUN_ERROR, message: "cancelled" } as never, "12");
    expect(scenario.activeSubscription()).toBeDefined();
    scenario.emit(runStarted("turn-b", ["turn-user-2", "turn-user-3"]), "13");
    expect(assistantTurnIds(scenario)).toEqual(["turn-a", "turn-b"]);
    expect(scenario.transport.cancelRequests).toHaveLength(1);
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests.at(-1)).toEqual({
      threadId: "thread_1",
      turnId: "turn-b",
    });
  });
});

describe("ThreadRunController follows the reply that answers its message", () => {
  it.each([
    ["the admission answer arrives after A finished", true],
    ["a fresh send is made after A finished", false],
  ])("waits for M2's reply when %s, inside A's grace window", async (_label, sentBeforeFinish) => {
    vi.useFakeTimers();
    const admission = scenarioGate<SendMessageResponse>();
    const scenario = makeScenario();
    scenario.resume({ expectedTurnId: "turn-a" });
    scenario.emit(runStarted("turn-a", ["turn-m1"]), "11");
    scenario.setAppend(() => admission.promise);
    const sent = sentBeforeFinish ? scenario.submit("M2") : undefined;
    scenario.emit(runFinished("turn-a"), "12");
    const response = defaultSendResponse({
      userTurnId: "turn-m2",
      assistantTurnId: null,
      resumeAfterSeq: "11",
    });
    admission.resolve(response);
    await (sent ?? scenario.submit("M2"));

    // A is complete: Stop waits for M2's reply instead of cancelling A.
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(scenario.activeSubscription()).toBeDefined();

    scenario.emit(runStarted("turn-b", ["turn-m2"]), "13");
    expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "turn-b" }]);
    expect(assistantTurnIds(scenario)).toEqual(["turn-a", "turn-b"]);
    scenario.emit(runFinished("turn-b"), "14");
    await vi.advanceTimersByTimeAsync(300);
    expect(scenario.activeSubscription()).toBeUndefined();
  });

  it("keeps waiting for M2's reply when A's start echo arrives after the admission", async () => {
    const scenario = makeScenario({
      append: async () => defaultSendResponse({ userTurnId: "turn-m1", assistantTurnId: "turn-a" }),
    });
    await scenario.submit("M1");
    scenario.setAppend(async () =>
      defaultSendResponse({ userTurnId: "turn-m2", assistantTurnId: null, resumeAfterSeq: "11" }),
    );
    await scenario.submit("M2 behind the switch");

    scenario.emit(runStarted("turn-a", ["turn-m1"]), "12");
    scenario.emit({ type: EventType.RUN_ERROR, message: "A failed" } as never, "13");
    expect(scenario.activeSubscription()).toBeDefined();

    scenario.emit(runStarted("turn-b", ["turn-m2"]), "14");
    expect(assistantTurnIds(scenario)).toEqual(["turn-a", "turn-b"]);
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "turn-b" }]);
  });

  it("settles from a gap snapshot when M2's reply started and finished inside the gap", async () => {
    const scenario = makeScenario({
      snapshot: async () =>
        snapshotOf([
          snapshotTurn("turn-m1", "user", 1, null),
          snapshotTurn("turn-a", "assistant", 2, "turn-m1"),
          snapshotTurn("turn-m2", "user", 3, "turn-a"),
          snapshotTurn("turn-b", "assistant", 4, "turn-m2"),
        ]),
    });
    await followAThenQueueM2(scenario);
    scenario.emit(runFinished("turn-a"), "12");
    scenario.controller.cancel("thread_1");

    scenario.reportGap();
    await vi.waitFor(() => expect(scenario.activeSubscription()).toBeUndefined());
    expect(scenario.snapshotRequests.length).toBeGreaterThan(0);
    // The Stop aimed at B is retired with it, not carried to a later reply.
    scenario.resume();
    scenario.emit(runStarted("turn-c", ["turn-m3"]), "20");
    expect(scenario.transport.cancelRequests).toEqual([]);
  });

  it("binds M2's reply from a gap snapshot that shows it still running", async () => {
    const scenario = makeScenario({
      snapshot: async () =>
        snapshotOf(
          [
            snapshotTurn("turn-m1", "user", 1, null),
            snapshotTurn("turn-a", "assistant", 2, "turn-m1"),
            snapshotTurn("turn-m2", "user", 3, "turn-a"),
            snapshotTurn("turn-b", "assistant", 4, "turn-m2", "streaming"),
          ],
          "turn-b",
        ),
    });
    await followAThenQueueM2(scenario);
    scenario.emit(runFinished("turn-a"), "12");
    scenario.controller.cancel("thread_1");

    scenario.reportGap();
    await vi.waitFor(() =>
      expect(scenario.transport.cancelRequests).toEqual([
        { threadId: "thread_1", turnId: "turn-b" },
      ]),
    );
    expect(scenario.activeSubscription()).toBeDefined();
  });

  it("keeps waiting when a gap snapshot shows M2 still unanswered", async () => {
    const scenario = makeScenario({
      snapshot: async () =>
        snapshotOf([
          snapshotTurn("turn-m1", "user", 1, null),
          snapshotTurn("turn-a", "assistant", 2, "turn-m1"),
          snapshotTurn("turn-m2", "user", 3, "turn-a"),
        ]),
    });
    await followAThenQueueM2(scenario);
    scenario.emit(runFinished("turn-a"), "12");
    await new Promise((resolve) => setTimeout(resolve, 300));

    scenario.reportGap();
    await vi.waitFor(() => expect(scenario.snapshotRequests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scenario.activeSubscription()).toBeDefined();
    scenario.emit(runStarted("turn-b", ["turn-m2"]), "20");
    expect(assistantTurnIds(scenario)).toContain("turn-b");
  });

  it("ignores a replayed start that answers another message", async () => {
    const scenario = makeScenario({
      append: async () =>
        defaultSendResponse({ userTurnId: "turn-m2", assistantTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("M2");

    // The admission cursor predates the lock: M1's reply replays first.
    scenario.emit(runStarted("turn-x", ["turn-m1"]), "11");
    scenario.emit(
      { type: EventType.TEXT_MESSAGE_START, messageId: "turn-x::0", role: "assistant" } as never,
      "12",
    );
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests).toEqual([]);
    expect(assistantTurnIds(scenario)).not.toContain("turn-x");

    scenario.emit(runFinished("turn-x"), "13");
    scenario.emit(runStarted("turn-b", ["turn-m2"]), "14");
    expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "turn-b" }]);
    expect(assistantTurnIds(scenario)).toContain("turn-b");
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
    let nextSeq = "4000";
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
      snapshot: async () => snapshot(nextSeq),
    });
    scenario.store.getState().acceptDurableBlockSeq("thread_1", "4000");
    scenario.resume({ expectedTurnId: "run-1" });
    scenario.emit(runStarted("run-1"), "10");
    scenario.reportGap();
    await vi.advanceTimersByTimeAsync(500);
    expect(scenario.store.getState().durableBlockCursorByThread.thread_1).toBe("4000");
    nextSeq = "5000";
    await vi.advanceTimersByTimeAsync(1000);
    expect(scenario.snapshotRequests.length).toBeLessThanOrEqual(6);
    expect(scenario.store.getState().durableBlockCursorByThread.thread_1).toBe("4999");
    expect(scenario.activeSubscription()).toBeDefined();
    scenario.emit(
      { type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "run-1" } as never,
      "5001",
    );
    expect(scenario.turns()[0]?.status).toBe("complete");
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
