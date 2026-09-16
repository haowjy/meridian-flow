/** Behavioral coverage for the stateful ThreadRunController lifecycle. */

import type {
  AdmissionLookup,
  SendMessageResponse,
  Thread,
  ThreadSnapshotResponse,
  Turn,
} from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { MeridianApiError } from "@/client/api/meridian-error";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
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
  ref: "c1",
  currentAgent: null,
  agentDefinitionRevisionId: null,
  agentName: null,
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
  writeMode: null,
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
    actionRequired: false,
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
      {
        data: expect.objectContaining({
          threadId: "thread_1",
          text: "Hello",
          connectionToken: "conn-late",
          blocks: [{ type: "text", text: "Hello" }],
          references: [],
          submissionId: expect.any(String),
        }),
      },
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
      lifecycle: { actionRequired: false, runningTurnId: null },
    });
    expect(scenario.turns().map((turn) => turn.id)).toEqual(["turn_user_server"]);

    scenario.store
      .getState()
      .applyThreadSnapshot(thread, [serverUserTurnFrom(optimistic, "turn_user_server")], {
        nextSeq: "43",
        lifecycle: { actionRequired: false, runningTurnId: null },
      });
    scenario.store.getState().applyThreadSnapshot(thread, [], {
      nextSeq: "42",
      lifecycle: { actionRequired: false, runningTurnId: null },
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
    admission.reject(new HttpResponseError("Turn already running", 409, null));
    await expect(submit).resolves.toMatchObject({ kind: "rejected" });

    expect(scenario.activeSubscription()).toBeDefined();
    expect(scenario.turns()).toEqual([waitingInterruptTurn]);
  });

  it("rejects concurrent admission while Stop still targets the previous run", async () => {
    const admission = scenarioGate<SendMessageResponse>();
    const scenario = new ThreadRunScenario({ append: () => admission.promise });
    scenario.resume({ after: "42", expectedTurnId: "turn_old" });

    const first = scenario.submit("first");
    const optimistic = scenario.store.getState().appendUserTurn("thread_1", "second");
    await expect(
      scenario.submit("second", { optimisticUserTurnId: optimistic.id }),
    ).resolves.toMatchObject({ kind: "rejected" });
    expect(scenario.turns()).toEqual([]);
    scenario.controller.cancel("thread_1");
    expect(scenario.transport.cancelRequests).toEqual([
      { threadId: "thread_1", turnId: "turn_old" },
    ]);

    admission.resolve(defaultSendResponse());
    await first;
    expect(scenario.transport.subscriptions).toHaveLength(2);
  });

  it("classifies connection preflight failure as definite and rolls back its optimistic row", async () => {
    const scenario = new ThreadRunScenario();
    scenario.disconnectAdmission();
    const optimistic = scenario.store.getState().appendUserTurn("thread_1", "not dispatched");

    const submit = scenario.submit("not dispatched", { optimisticUserTurnId: optimistic.id });
    scenario.rejectConnection(new Error("connection unavailable"));
    await expect(submit).resolves.toMatchObject({ kind: "rejected" });
    expect(scenario.appendRequests).toEqual([]);
    expect(scenario.turns()).toEqual([]);
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
      kind: "rejected",
    },
    {
      label: "authoritative plain HTTP rejection",
      error: new HttpResponseError("Turn already running", 409, {
        statusCode: 409,
        message: "Turn already running",
      }),
      remaining: 0,
      kind: "rejected",
    },
    {
      label: "ambiguous network failure",
      error: new TypeError("fetch failed"),
      remaining: 1,
      kind: "ambiguous",
    },
  ] as const)("handles optimistic turns after $label", async ({ error, remaining, kind }) => {
    const scenario = new ThreadRunScenario({ append: async () => Promise.reject(error) });
    const optimistic = scenario.store.getState().appendUserTurn("thread_1", "possibly persisted");

    await expect(
      scenario.submit("possibly persisted", { optimisticUserTurnId: optimistic.id }),
    ).resolves.toMatchObject({ kind });
    expect(scenario.turns()).toHaveLength(remaining);
  });

  it("reconciles response loss by lookup of the same identity without a second POST", async () => {
    const scenario = new ThreadRunScenario({
      append: async () => Promise.reject(new TypeError("response lost")),
      lookup: async ({ threadId, submissionId }) => ({
        kind: "accepted",
        threadId: threadId as never,
        submissionId,
        userTurnId: "turn-user" as never,
        assistantTurnId: "turn_1" as never,
        resumeAfterSeq: "42",
        snapshotFloorNextSeq: "43",
      }),
    });
    const outcome = await scenario.submit("exact");
    expect(outcome.kind).toBe("accepted");
    expect(scenario.appendRequests).toHaveLength(1);
    expect(scenario.lookupRequests).toEqual([
      {
        threadId: "thread_1",
        submissionId: scenario.appendRequests[0]?.data.submissionId,
      },
    ]);
  });

  it("recovers an unseen first Send with the exact saved envelope", async () => {
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
    });
    const envelope = serializeComposerDraft(plainComposerDoc("Saved opening"), 7);
    const outcome = await scenario.controller.recoverFirstSend("thread_1", envelope);
    expect(scenario.appendRequests).toHaveLength(1);
    expect(scenario.appendRequests[0]?.data).toMatchObject({
      submissionId: envelope.submissionId,
      text: envelope.text,
      blocks: envelope.blocks,
      references: envelope.references,
      connectionToken: "conn-test",
    });
    expect(outcome).toMatchObject({
      kind: "accepted",
      submissionId: envelope.submissionId,
      acceptedRevision: 7,
    });
  });

  it("keeps status checks read-only even when the ID is unseen", async () => {
    const scenario = new ThreadRunScenario();
    const envelope = serializeComposerDraft(plainComposerDoc("Saved"));
    expect(await scenario.controller.lookup("thread_1", envelope)).toMatchObject({
      kind: "ambiguous",
    });
    expect(scenario.appendRequests).toEqual([]);
  });

  it.each(["pending", "network"] as const)("does not replay after %s lookup", async (kind) => {
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => {
        if (kind === "network") throw new TypeError("offline");
        return { kind: "pending", submissionId };
      },
    });
    const envelope = serializeComposerDraft(plainComposerDoc("Saved"));
    expect(await scenario.controller.recoverFirstSend("thread_1", envelope)).toMatchObject({
      kind: "ambiguous",
    });
    expect(scenario.appendRequests).toEqual([]);
  });

  it("does not loop when its single replay loses the response", async () => {
    const scenario = new ThreadRunScenario({
      append: async () => {
        throw new TypeError("response lost");
      },
    });
    const envelope = serializeComposerDraft(plainComposerDoc("Saved"));
    expect(await scenario.controller.recoverFirstSend("thread_1", envelope)).toMatchObject({
      kind: "ambiguous",
    });
    expect(scenario.appendRequests).toHaveLength(1);
    expect(scenario.lookupRequests).toHaveLength(2);
    expect(scenario.appendRequests[0]?.data.submissionId).toBe(envelope.submissionId);
  });

  it("preserves uncertainty when recovery cannot obtain a connection token", async () => {
    const scenario = new ThreadRunScenario();
    scenario.disconnectAdmission();
    const envelope = serializeComposerDraft(plainComposerDoc("Saved"));
    const recovery = scenario.controller.recoverFirstSend("thread_1", envelope);
    await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(1));
    scenario.rejectConnection(new Error("disconnected"));
    expect(await recovery).toMatchObject({ kind: "ambiguous" });
    expect(scenario.appendRequests).toEqual([]);
    expect(scenario.lookupRequests).toHaveLength(2);
  });

  it("fences token-wait recovery after navigation without blocking the new Send", async () => {
    const scenario = new ThreadRunScenario();
    scenario.disconnectAdmission();
    const envelope = serializeComposerDraft(plainComposerDoc("Old"));
    const recovery = scenario.controller.recoverFirstSend("thread_1", envelope);
    await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(1));
    scenario.controller.teardown();
    const next = scenario.controller.submit(
      "thread_2",
      serializeComposerDraft(plainComposerDoc("New")),
    );
    scenario.connect("new-token");
    expect(await recovery).toMatchObject({ kind: "ambiguous" });
    expect(await next).toMatchObject({ kind: "accepted" });
    expect(scenario.appendRequests.map((request) => request.data.threadId)).toEqual(["thread_2"]);
    expect(scenario.activeSubscription()?.threadId).toBe("thread_2");
  });

  it.each([
    "resolve",
    "reject",
  ] as const)("ignores a stale recovery POST %s after a new run starts", async (settlement) => {
    const gate = scenarioGate<SendMessageResponse>();
    const scenario = new ThreadRunScenario({
      append: async ({ data }) =>
        data.threadId === "thread_1" ? gate.promise : defaultSendResponse(),
    });
    const optimistic = scenario.store.getState().appendUserTurn("thread_1", "Old");
    const recovery = scenario.controller.recoverFirstSend(
      "thread_1",
      serializeComposerDraft(plainComposerDoc("Old")),
      { optimisticUserTurnId: optimistic.id },
    );
    await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    scenario.controller.teardown();
    await scenario.controller.submit("thread_2", serializeComposerDraft(plainComposerDoc("New")));
    if (settlement === "resolve") gate.resolve(defaultSendResponse());
    else gate.reject(new TypeError("lost response"));
    await recovery;
    expect(scenario.lookupRequests).toHaveLength(1);
    expect(scenario.turns()[0]?.id).toBe(optimistic.id);
    expect(scenario.activeSubscription()?.threadId).toBe("thread_2");
    expect(scenario.transport.subscriptions).toHaveLength(1);
  });

  it("fences a delayed post-failure lookup with the original recovery epoch", async () => {
    const gate = scenarioGate<AdmissionLookup>();
    const scenario = new ThreadRunScenario({
      append: async ({ data }) => {
        if (data.threadId === "thread_1") throw new TypeError("lost response");
        return defaultSendResponse();
      },
      lookup: async ({ submissionId }): Promise<AdmissionLookup> =>
        scenario.lookupRequests.length === 1 ? { kind: "not-seen", submissionId } : gate.promise,
    });
    const envelope = serializeComposerDraft(plainComposerDoc("Old"));
    const recovery = scenario.controller.recoverFirstSend("thread_1", envelope);
    await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(2));
    scenario.controller.teardown();
    await scenario.controller.submit("thread_2", serializeComposerDraft(plainComposerDoc("New")));
    gate.resolve({
      ...defaultSendResponse(),
      kind: "accepted",
      submissionId: envelope.submissionId,
    });
    await recovery;
    expect(scenario.activeSubscription()?.threadId).toBe("thread_2");
    expect(scenario.transport.subscriptions).toHaveLength(1);
  });

  it("preserves an authoritative replay fingerprint conflict", async () => {
    const scenario = new ThreadRunScenario({
      append: async () => {
        throw new MeridianApiError({
          code: "idempotency_conflict",
          message: "Different envelope",
          retryable: false,
          source: "system",
        });
      },
      lookup: async ({ threadId, submissionId }): Promise<AdmissionLookup> =>
        scenario.lookupRequests.length === 1
          ? { kind: "not-seen", submissionId }
          : {
              ...defaultSendResponse(),
              kind: "accepted",
              threadId: threadId as never,
              submissionId,
            },
    });
    const envelope = serializeComposerDraft(plainComposerDoc("Saved"));
    expect(await scenario.controller.recoverFirstSend("thread_1", envelope)).toMatchObject({
      kind: "rejected",
    });
    expect(scenario.lookupRequests).toHaveLength(1);
    expect(scenario.transport.subscriptions).toEqual([]);
  });

  it("does not replay a delayed lookup after controller teardown", async () => {
    const gate = scenarioGate<{ kind: "not-seen"; submissionId: string }>();
    const scenario = new ThreadRunScenario({ lookup: () => gate.promise });
    const envelope = serializeComposerDraft(plainComposerDoc("Saved"));
    const recovery = scenario.controller.recoverFirstSend("thread_1", envelope);
    scenario.controller.teardown();
    gate.resolve({ kind: "not-seen", submissionId: envelope.submissionId });
    expect(await recovery).toMatchObject({ kind: "ambiguous" });
    expect(scenario.appendRequests).toEqual([]);
    expect(scenario.transport.subscriptions).toEqual([]);
  });

  it("keeps pending lookup ambiguous and maps explicit retirement's durable winner", async () => {
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "pending", submissionId }),
      retire: async ({ submissionId }) => ({ kind: "retired", submissionId, code: "retired" }),
    });
    const envelope = serializeComposerDraft(plainComposerDoc("uncertain"));
    await expect(scenario.controller.lookup("thread_1", envelope)).resolves.toMatchObject({
      kind: "ambiguous",
    });
    await expect(scenario.controller.retire("thread_1", envelope)).resolves.toMatchObject({
      kind: "rejected",
    });
    expect(scenario.appendRequests).toEqual([]);
    expect(scenario.retireRequests).toEqual([
      { threadId: "thread_1", submissionId: envelope.submissionId },
    ]);
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
      lifecycle: { actionRequired: false, runningTurnId: null },
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
