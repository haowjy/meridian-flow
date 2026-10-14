/** Controller recovery fences: a submission or recovery outlives neither its session nor its owner. */
import type {
  AdmissionLookup,
  RetireAdmissionResult,
  SendMessageResponse,
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
      runStateVersion: null,
      resumeAfterSeq: "42",
      snapshotFloorNextSeq: "43",
    });
    append.resolve(defaultSendResponse());
    await expect(recovered).resolves.toMatchObject({ kind: "abandoned" });
    await expect(submitted).resolves.toMatchObject({ kind: "abandoned" });
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
      runStateVersion: null,
      resumeAfterSeq: "42",
      snapshotFloorNextSeq: "43",
    });

    await expect(pending).resolves.toMatchObject({ kind: "abandoned" });
    expect(scenario.turns()).toEqual([expect.objectContaining({ id: row.id, status: "pending" })]);
  });

  it("keeps sibling recovery sessions independent when one ends", async () => {
    const scenario = makeScenario({
      lookup: async ({ submissionId }) => ({
        kind: "already-accepted",
        threadId: "thread_1",
        submissionId,
        userTurnId: `turn-${submissionId}`,
        runStateVersion: null,
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
