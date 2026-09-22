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

  it("does not acknowledge or retire when a POST completes after teardown", async () => {
    const scenario = new ThreadRunScenario();
    const gate = scenarioGate<SendMessageResponse>();
    scenario.setAppend(() => gate.promise);

    const pending = scenario.submit("Hello");
    await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    scenario.controller.teardown();
    gate.resolve(defaultSendResponse());

    await expect(pending).resolves.toMatchObject({ kind: "ambiguous" });
  });
});
