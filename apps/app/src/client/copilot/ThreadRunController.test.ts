/**
 * Write-outcome classification: a durable journal entry may be retired only on
 * a proved rejection. Connection-token failures, unknown 5xx, and a POST that
 * completes after teardown must stay ambiguous so recovery can reconcile.
 */
import type { SendMessageResponse } from "@meridian/contracts/protocol";
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
});
