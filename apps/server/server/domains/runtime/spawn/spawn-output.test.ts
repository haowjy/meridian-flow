import { describe, expect, it } from "vitest";

import {
  invocationCardProps,
  spawnOutputForTranscript,
  unadmittedInvocationFailure,
  unadmittedInvocationFailureProps,
} from "./spawn-output.js";

describe("spawnOutputForTranscript", () => {
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

  it("removes internal execution and thread ids from model-facing spawn output", () => {
    const error = { status: "error", error: { code: "spawn_depth_exceeded" } };
    const background = {
      status: "background",
      handle: "p2",
      threadId: "child-2",
      execution: "private-execution-id",
      agentSlug: "general",
    };
    const completed = {
      status: "completed",
      execution: "private-execution-id",
      report: { handle: "p2", threadId: "child-2", summary: "Done", costMillicredits: 5 },
    };

    expect(spawnOutputForTranscript(error)).toEqual(error);
    expect(spawnOutputForTranscript({ ...error, execution: "private-execution-id" })).toEqual(
      error,
    );
    expect(spawnOutputForTranscript(background)).toEqual({
      status: "background",
      handle: "p2",
      agentSlug: "general",
    });
    expect(spawnOutputForTranscript(completed)).toEqual({
      status: "completed",
      report: { handle: "p2", summary: "Done" },
    });
  });

  it("tells the model a queued thread_message has no pushed reply", () => {
    const background = {
      status: "background",
      handle: "c1",
      threadId: "primary-1",
      agentSlug: "primary",
      notifiesCaller: false,
    };

    expect(spawnOutputForTranscript(background, { queuedMessage: true })).toEqual({
      status: "background",
      handle: "c1",
      agentSlug: "primary",
      notifiesCaller: false,
      note: "Message queued. No reply is pushed back; the target's response is readable in its transcript.",
    });
  });

  it("tells a parent that re-tasked its own child it will be notified", () => {
    const background = {
      status: "background",
      handle: "p3",
      threadId: "child-3",
      agentSlug: "critic",
      notifiesCaller: true,
    };

    expect(spawnOutputForTranscript(background, { queuedMessage: true })).toEqual({
      status: "background",
      handle: "p3",
      agentSlug: "critic",
      notifiesCaller: true,
      note: "Message queued. You'll be notified when p3 finishes.",
    });
  });
});
