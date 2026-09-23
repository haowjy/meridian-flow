/**
 * Write-outcome classification at the controller boundary: a durable journal
 * entry may be retired only on a proved rejection. A connection-token failure
 * stays ambiguous, and a recovery retire that settles after its session ends
 * must not acknowledge or subscribe. Recovery's own file owns the rest of the
 * ambiguous-vs-rejected outcomes.
 */
import type { RetireAdmissionResult } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { scenarioGate, ThreadRunScenario } from "./test-support/ThreadRunScenario";

describe("ThreadRunController write outcomes", () => {
  it("keeps a connection-token failure ambiguous", async () => {
    const scenario = new ThreadRunScenario();
    scenario.disconnectAdmission();

    const pending = scenario.submit("Hello");
    scenario.rejectConnection(new Error("socket offline"));

    await expect(pending).resolves.toMatchObject({ kind: "ambiguous" });
  });

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
