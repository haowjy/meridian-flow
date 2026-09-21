/** Controller recovery fences and mid-run queue admission subscription continuity. */
import { EventType, type RetireAdmissionResult } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  defaultSendResponse,
  scenarioGate,
  ThreadRunScenario,
} from "./test-support/ThreadRunScenario";

describe("ThreadRunController write outcomes", () => {
  it("does not acknowledge or start a run when a recovery retire settles after its session ends", async () => {
    const gate = scenarioGate<RetireAdmissionResult>();
    const scenario = new ThreadRunScenario({ retire: () => gate.promise });
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
    const scenario = new ThreadRunScenario({
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
    const scenario = new ThreadRunScenario({
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
    const scenario = new ThreadRunScenario({
      append: async () => defaultSendResponse({ assistantTurnId: null, resumeAfterSeq: "10" }),
    });
    await scenario.submit("hello");
    scenario.emit(runStarted("run-1"), "11");

    await scenario.submit("again");

    expect(scenario.transport.subscriptions).toHaveLength(2);
  });
});
