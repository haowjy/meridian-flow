/**
 * Write-outcome classification: a durable journal entry may be retired only on
 * a proved rejection. Connection-token failures, unknown 5xx, and a POST that
 * completes after teardown must stay ambiguous so recovery can reconcile.
 */
import type {
  AdmissionLookup,
  RetireAdmissionResult,
  SendMessageResponse,
} from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import {
  defaultSendResponse,
  scenarioGate,
  ThreadRunScenario,
} from "./test-support/ThreadRunScenario";

describe("ThreadRunController write outcomes", () => {
  it("keeps a connection-token failure ambiguous", async () => {
    const scenario = new ThreadRunScenario();
    scenario.disconnectAdmission();

    const pending = scenario.submit("Hello");
    scenario.rejectConnection(new Error("socket offline"));

    await expect(pending).resolves.toMatchObject({ kind: "ambiguous" });
  });

  it("keeps an unknown 5xx ambiguous", async () => {
    const scenario = new ThreadRunScenario();
    scenario.setAppend(async () => {
      throw new HttpResponseError("bad gateway", 502, null);
    });

    await expect(scenario.submit("Hello")).resolves.toMatchObject({ kind: "ambiguous" });
  });

  it("keeps a grounded 4xx rejected", async () => {
    const scenario = new ThreadRunScenario();
    scenario.setAppend(async () => {
      throw new HttpResponseError("invalid message", 400, null);
    });

    await expect(scenario.submit("Hello")).resolves.toMatchObject({ kind: "rejected" });
  });

  it("bridges the app-scoped row but stays ambiguous when a POST completes after teardown", async () => {
    const scenario = new ThreadRunScenario();
    const gate = scenarioGate<SendMessageResponse>();
    scenario.setAppend(() => gate.promise);

    const optimisticUserTurn = scenario.store.getState().appendUserTurn("thread_1", "Hello");
    const pending = scenario.controller.submit(
      "thread_1",
      {
        submissionId: "sub-1",
        acceptedRevision: 0,
        text: "Hello",
        blocks: [{ type: "text", text: "Hello" }],
        references: [],
        activatedSkillSlugs: [],
      },
      { optimisticUserTurnId: optimisticUserTurn.id },
    );
    await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    scenario.controller.teardown();
    gate.resolve(defaultSendResponse());

    // The stale session stays ambiguous so the caller keeps the journal, but
    // the app-scoped row is still bridged to the persisted turn: an unbridged
    // row would make the returning session append a duplicate pending row.
    await expect(pending).resolves.toMatchObject({ kind: "ambiguous" });
    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: "turn-user", status: "complete" }),
    ]);
  });

  it("keeps the optimistic row on a rejected admission when recovery keeps it", async () => {
    const scenario = new ThreadRunScenario();
    scenario.setAppend(async () => {
      throw new HttpResponseError("invalid message", 400, null);
    });
    const row = scenario.store.getState().appendUserTurn("thread_1", "Hello");

    const pending = scenario.controller.submit(
      "thread_1",
      {
        submissionId: "sub-keep",
        acceptedRevision: 0,
        text: "Hello",
        blocks: [{ type: "text", text: "Hello" }],
        references: [],
        activatedSkillSlugs: [],
      },
      { optimisticUserTurnId: row.id, keepOptimisticOnFailure: true },
    );

    // The live rejection owner needs the row left on the turn to attach
    // Retry / Edit; the controller must not drop it.
    await expect(pending).resolves.toMatchObject({ kind: "rejected" });
    expect(scenario.turns()).toEqual([expect.objectContaining({ id: row.id })]);
  });

  it("drops the optimistic row on a rejected admission when recovery does not keep it", async () => {
    const scenario = new ThreadRunScenario();
    scenario.setAppend(async () => {
      throw new HttpResponseError("invalid message", 400, null);
    });
    const row = scenario.store.getState().appendUserTurn("thread_1", "Hello");

    const pending = scenario.controller.submit(
      "thread_1",
      {
        submissionId: "sub-drop",
        acceptedRevision: 0,
        text: "Hello",
        blocks: [{ type: "text", text: "Hello" }],
        references: [],
        activatedSkillSlugs: [],
      },
      { optimisticUserTurnId: row.id },
    );

    await expect(pending).resolves.toMatchObject({ kind: "rejected" });
    expect(scenario.turns()).toEqual([]);
  });

  it("does not acknowledge or start a run when a recovery lookup settles after its session ends", async () => {
    const gate = scenarioGate<AdmissionLookup>();
    const scenario = new ThreadRunScenario({ lookup: () => gate.promise });
    const session = {};
    scenario.controller.beginRecoverySession(session);
    const row = scenario.store.getState().appendUserTurn("thread_1", "Hello");
    const pending = scenario.controller.lookupSubmission(
      "thread_1",
      "sub-1",
      { optimisticUserTurnId: row.id },
      session,
    );
    await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(1));

    // A genuine unmount removes the token while the lookup is in flight.
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

    // The late accept must not be bridged, acknowledged, or subscribed.
    await expect(pending).resolves.toMatchObject({ kind: "ambiguous" });
    expect(scenario.turns()).toEqual([expect.objectContaining({ id: row.id, status: "pending" })]);
    expect(scenario.activeSubscription()).toBeUndefined();
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
