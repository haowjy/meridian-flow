/** Behavioral coverage for the stateful ThreadRunController lifecycle. */

import type {
  SendMessageResponse,
  Thread,
  ThreadSnapshotResponse,
  Turn,
} from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import {
  defaultSendResponse,
  scenarioGate,
  ThreadRunScenario,
} from "./test-support/ThreadRunScenario";

const thread: Thread = {
  id: "thread_1",
  projectId: "project_1",
  workId: null,
  userId: "user_1",
  kind: "primary",
  status: "active",
  title: "Thread",
  currentAgent: null,
  activeLeafTurnId: null,
  parentThreadId: null,
  rootThreadId: "thread_1",
  spawnDepth: 0,
  spawnStatus: null,
  totalCostUsd: "0",
  turnCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const assistantTurn: Turn = {
  id: "turn_1",
  threadId: "thread_1",
  prevTurnId: null,
  parentTurnId: null,
  role: "assistant",
  status: "complete",
  finishReason: "end_turn",
  model: null,
  provider: null,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  totalCostUsd: "0",
  responseCount: 0,
  usage: null,
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  blocks: [],
  siblingIds: [],
  responses: [],
};

const waitingInterruptTurn: Turn = {
  ...assistantTurn,
  id: "turn_interrupt",
  status: "waiting_interrupt",
  finishReason: null,
  completedAt: null,
};

function snapshot(nextSeq = "10", turns: Turn[] = [assistantTurn]): ThreadSnapshotResponse {
  return {
    threadId: "thread_1",
    thread,
    turns,
    liveState: {
      threadId: "thread_1",
      status: "active",
      runningTurnId: "turn_1",
      currentAgent: null,
      resumeAfterSeq: "9",
    },
    attention: "none",
    nextSeq,
  };
}

function serverUserTurnFrom(optimisticTurn: Turn, serverTurnId: string): Turn {
  return {
    ...optimisticTurn,
    id: serverTurnId,
    blocks: optimisticTurn.blocks.map((block) => ({
      ...block,
      id: `${serverTurnId}-block-${block.sequence}`,
      turnId: serverTurnId,
    })),
  };
}

describe("ThreadRunController", () => {
  it("waits for admission, subscribes from the receipt, and records the completed transcript", async () => {
    const scenario = new ThreadRunScenario();
    scenario.disconnectAdmission();

    const submit = scenario.submit("Hello");
    await Promise.resolve();
    expect(scenario.appendRequests).toEqual([]);

    scenario.connect("conn-late");
    await submit;
    expect(scenario.appendRequests).toEqual([
      { data: { threadId: "thread_1", text: "Hello", connectionToken: "conn-late" } },
    ]);
    expect(scenario.activeSubscription()).toMatchObject({
      threadId: "thread_1",
      options: { after: "42" },
    });

    scenario.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" }, "43");
    scenario.emit(
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg_1", role: "assistant" },
      "44",
    );
    scenario.emit({ type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "turn_1" }, "45");

    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: "turn_1", status: "complete" }),
    ]);
    expect(scenario.activeSubscription()).toBeUndefined();
  });

  it("keeps an acknowledged optimistic turn until the ordered projection catches up", async () => {
    const scenario = new ThreadRunScenario({
      append: async () => defaultSendResponse({ userTurnId: "turn_user_server" }),
    });
    const optimistic = scenario.store.getState().appendUserTurn("thread_1", "Hello");

    await scenario.submit("Hello", { optimisticUserTurnId: optimistic.id });
    scenario.store.getState().applyThreadSnapshot(thread, [], {
      nextSeq: "42",
      lifecycle: { attention: "none", runningTurnId: null },
    });
    expect(scenario.turns().map((turn) => turn.id)).toEqual(["turn_user_server"]);

    scenario.store
      .getState()
      .applyThreadSnapshot(thread, [serverUserTurnFrom(optimistic, "turn_user_server")], {
        nextSeq: "43",
        lifecycle: { attention: "none", runningTurnId: null },
      });
    scenario.store.getState().applyThreadSnapshot(thread, [], {
      nextSeq: "42",
      lifecycle: { attention: "none", runningTurnId: null },
    });
    expect(scenario.turns().map((turn) => turn.id)).toEqual(["turn_user_server"]);
  });

  it("resumes a known run without waiting for RUN_STARTED", () => {
    const scenario = new ThreadRunScenario();
    scenario.resume({ after: "100", expectedTurnId: "turn_1" });

    scenario.emit(
      { type: EventType.TEXT_MESSAGE_START, messageId: "tail_msg", role: "assistant" },
      "101",
    );
    scenario.emit({ type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "turn_1" }, "102");

    expect(scenario.appendRequests).toEqual([]);
    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: "turn_1", status: "complete" }),
    ]);
  });

  it("forwards interrupt responses and cancellation outcomes", async () => {
    const scenario = new ThreadRunScenario();
    scenario.resume({ after: "42", expectedTurnId: "turn_1" });
    scenario.controller.respondInterrupt({
      threadId: "thread_1",
      turnId: "turn_1",
      interruptId: "interrupt_1",
      value: { value: "approved" },
    });
    scenario.controller.cancel("thread_1");
    await Promise.resolve();

    expect(scenario.transport.interruptResponses).toEqual([
      {
        threadId: "thread_1",
        turnId: "turn_1",
        interruptId: "interrupt_1",
        value: { value: "approved" },
      },
    ]);
    expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "turn_1" }]);
  });

  it("holds an early stop until RUN_STARTED supplies the turn id", async () => {
    const scenario = new ThreadRunScenario();
    scenario.resume({ after: "42" });
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests).toEqual([]);

    scenario.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" }, "43");
    await Promise.resolve();
    expect(scenario.transport.cancelRequests).toEqual([{ threadId: "thread_1", turnId: "turn_1" }]);
  });

  it("drops cross-thread and superseded-run events", () => {
    const scenario = new ThreadRunScenario();
    scenario.resume({ after: "42", expectedTurnId: "turn_1" });
    scenario.emit(
      { type: EventType.RUN_STARTED, threadId: "thread_child", runId: "turn_child" },
      "43",
      "thread_child",
    );
    scenario.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_old" }, "44");
    scenario.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" }, "45");

    expect(scenario.turns().map((turn) => turn.id)).toEqual(["turn_1"]);
  });

  it("keeps one live subscription and ignores the disposed stream", () => {
    const scenario = new ThreadRunScenario();
    scenario.resume({ after: "1", expectedTurnId: "turn_1" });
    scenario.resume({ after: "2", expectedTurnId: "turn_2" });

    scenario.transport.emitTo(
      0,
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      "3",
    );
    scenario.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_2" }, "4");

    expect(scenario.transport.subscriptions.map(({ active }) => active)).toEqual([false, true]);
    expect(scenario.turns().map((turn) => turn.id)).toEqual(["turn_2"]);
  });

  it("does not disturb the active run when a new admission is rejected", async () => {
    const admission = scenarioGate<SendMessageResponse>();
    const scenario = new ThreadRunScenario({ append: () => admission.promise });
    scenario.store.setState({ turnsByThread: { thread_1: [waitingInterruptTurn] } });
    scenario.resume({ after: "42", expectedTurnId: "turn_interrupt" });

    const submit = scenario.submit("too soon");
    admission.reject(new Error("Turn already running"));
    await expect(submit).rejects.toThrow("Turn already running");

    expect(scenario.activeSubscription()).toBeDefined();
    expect(scenario.turns()).toEqual([waitingInterruptTurn]);
  });

  it("rejects concurrent admission while Stop still targets the previous run", async () => {
    const admission = scenarioGate<SendMessageResponse>();
    const scenario = new ThreadRunScenario({ append: () => admission.promise });
    scenario.resume({ after: "42", expectedTurnId: "turn_old" });

    const first = scenario.submit("first");
    await expect(scenario.submit("second")).rejects.toThrow("submit already in flight");
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests).toEqual([
      { threadId: "thread_1", turnId: "turn_old" },
    ]);

    admission.resolve(defaultSendResponse());
    await first;
    expect(scenario.transport.subscriptions).toHaveLength(2);
  });

  it.each([
    {
      label: "definitive API rejection",
      error: new MeridianApiError({
        code: "already_active",
        message: "Turn already running",
        retryable: false,
        source: "system",
      }),
      remaining: 0,
    },
    { label: "ambiguous network failure", error: new TypeError("fetch failed"), remaining: 1 },
  ])("handles optimistic turns after $label", async ({ error, remaining }) => {
    const scenario = new ThreadRunScenario({ append: async () => Promise.reject(error) });
    const optimistic = scenario.store.getState().appendUserTurn("thread_1", "possibly persisted");

    await expect(
      scenario.submit("possibly persisted", { optimisticUserTurnId: optimistic.id }),
    ).rejects.toThrow();
    expect(scenario.turns()).toHaveLength(remaining);
  });

  it("prunes an abandoned assistant row only after a new submit is accepted", async () => {
    let admission = 0;
    const scenario = new ThreadRunScenario({
      append: async () =>
        defaultSendResponse(
          admission++ === 0
            ? {}
            : { assistantTurnId: "turn_2", resumeAfterSeq: "100", snapshotFloorNextSeq: "101" },
        ),
    });

    await scenario.submit("first");
    scenario.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" }, "43");
    scenario.failStream(new Error("socket failed"));
    await scenario.submit("second");
    scenario.emit({ type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_2" }, "101");

    expect(scenario.turns().map((turn) => turn.id)).toEqual(["turn_2"]);
  });

  it("coalesces gap recovery and rejects an older recovery snapshot", async () => {
    const recovery = scenarioGate<ThreadSnapshotResponse>();
    const scenario = new ThreadRunScenario({ snapshot: () => recovery.promise });
    scenario.store.getState().applyThreadSnapshot(thread, [assistantTurn], {
      nextSeq: "9007199254740993",
      lifecycle: { attention: "none", runningTurnId: null },
    });
    scenario.resume({ after: "42", expectedTurnId: "turn_1" });

    scenario.reportGap();
    scenario.reportGap();
    expect(scenario.snapshotRequests).toEqual(["thread_1"]);
    recovery.resolve(snapshot("9007199254740992", []));

    await vi.waitFor(() => expect(scenario.snapshotRequests).toHaveLength(1));
    expect(scenario.turns()).toEqual([assistantTurn]);
  });
});
