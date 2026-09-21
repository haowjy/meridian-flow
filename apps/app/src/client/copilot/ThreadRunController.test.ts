/**
 * Mid-run merge must continue the live subscription. Re-subscribing from the
 * enqueue cursor rewinds past deltas the client already applied and replays
 * them, so the controller keeps the running subscription when the server
 * reports the same live run.
 */
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { defaultSendResponse, ThreadRunScenario } from "./test-support/ThreadRunScenario";

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
