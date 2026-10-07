import { describe, expect, it } from "vitest";

import {
  invocationCardProps,
  unadmittedInvocationFailure,
  unadmittedInvocationFailureProps,
} from "./spawn-output.js";

describe("invocation card props", () => {
  const correlation = {
    parentTurnId: "turn-1",
    toolCallId: "call-1",
    deliveryMode: "background_notification" as const,
  };

  it("retains the bound Agent's display name on running and completed cards", () => {
    const running = invocationCardProps({
      agent: "critic",
      agentName: "Critic (harsh)",
      name: "Continuity",
      correlation,
      childThreadId: "child-1",
      execution: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      terminalAt: null,
      fromThreadId: "source-1",
      fromThreadRef: "c1",
      fromThreadTitle: "Source conversation",
    });
    expect(running).toMatchObject({
      agentName: "Critic (harsh)",
      execution: null,
      terminalAt: null,
      title: "Continuity",
      fromThreadId: "source-1",
      fromThreadRef: "c1",
      fromThreadTitle: "Source conversation",
    });
    const done = invocationCardProps({
      agent: "critic",
      agentName: "Critic (harsh)",
      correlation,
      childThreadId: "child-1",
      execution: "execution-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T00:01:00.000Z",
      outcome: "succeeded",
    });
    expect(done).toMatchObject({
      agentName: "Critic (harsh)",
      outcome: "succeeded",
      terminalAt: "2026-01-01T00:01:00.000Z",
    });
    expect(done).not.toHaveProperty("summary");
    expect(done).not.toHaveProperty("payload");
    expect(done).not.toHaveProperty("artifacts");
    expect(JSON.stringify(done)).not.toContain("cost");
  });

  it("stores a writer-readable pre-admission failure without a child link", () => {
    const running = invocationCardProps({
      agent: "subagent",
      agentName: "Subagent",
      name: "Check continuity",
      correlation,
      childThreadId: "child-9",
      execution: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      terminalAt: null,
    });
    const failed = unadmittedInvocationFailure(running, "The agent is unavailable.");
    expect(failed).toMatchObject({
      agentName: "Subagent",
      reason: "The agent is unavailable.",
      terminalAt: expect.any(String),
      title: "Check continuity",
    });
    expect(failed).not.toHaveProperty("childThreadId");
    expect(failed).not.toHaveProperty("execution");
  });

  it("uses the slug verbatim for a pre-resolution failure", () => {
    expect(
      unadmittedInvocationFailureProps({
        agent: "continuity-checker",
        correlation,
        reason: "Unavailable.",
      }),
    ).toMatchObject({ agentSlug: "continuity-checker", agentName: "continuity-checker" });
  });
});
