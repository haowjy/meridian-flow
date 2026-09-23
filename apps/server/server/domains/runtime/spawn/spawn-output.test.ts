import { describe, expect, it } from "vitest";

import { spawnHelperCardProps, spawnOutputForTranscript } from "./spawn-output.js";

describe("spawnOutputForTranscript", () => {
  it("drops cost and threadId from a completed report while keeping the handle", () => {
    const output = spawnOutputForTranscript({
      status: "completed",
      report: {
        handle: "p1",
        threadId: "child-1",
        summary: "Stated that 2+2=4.",
        payload: { answer: 4 },
        costMillicredits: 69,
      },
    });

    expect(output).toEqual({
      status: "completed",
      report: {
        handle: "p1",
        summary: "Stated that 2+2=4.",
        payload: { answer: 4 },
      },
    });
    expect(JSON.stringify(output)).not.toContain("cost");
    expect(JSON.stringify(output)).not.toContain("threadId");
  });

  it("builds a running helper card then a body-free completed one", () => {
    const running = spawnHelperCardProps({
      parentTurnId: "turn-1",
      description: "Continuity",
    });
    expect(running).toMatchObject({
      agentName: "Subagent",
      status: "running",
      title: "Continuity",
    });
    expect(running.childThreadId).toBeUndefined();
    const done = spawnHelperCardProps({
      agent: "critic",
      parentTurnId: "turn-1",
      output: {
        status: "completed",
        report: {
          threadId: "child-1",
          summary: "Holds.",
          payload: { verdict: "ok" },
          costMillicredits: 9,
        },
      },
    });
    expect(done).toMatchObject({
      agentName: "Critic",
      status: "completed",
    });
    expect(done).not.toHaveProperty("summary");
    expect(done).not.toHaveProperty("payload");
    expect(JSON.stringify(done)).not.toContain("cost");
  });

  it("keeps report artifacts off the completed card", () => {
    const done = spawnHelperCardProps({
      agent: "critic",
      parentTurnId: "turn-1",
      output: {
        status: "completed",
        report: {
          threadId: "child-1",
          summary: "Wrote the outline.",
          artifacts: [{ type: "object", uri: "scratch://outline.md", label: "Outline" }],
          costMillicredits: 5,
        },
      },
    });

    expect(done.artifacts).toBeUndefined();
    expect(JSON.stringify(done)).not.toContain("cost");
  });

  it("omits artifacts when the completed report has none", () => {
    const done = spawnHelperCardProps({
      parentTurnId: "turn-1",
      output: {
        status: "completed",
        report: { threadId: "child-1", summary: "No files.", costMillicredits: 2 },
      },
    });

    expect(done.artifacts).toBeUndefined();
  });

  it("keeps childThreadId on a failed card and titles from description", () => {
    const failed = spawnHelperCardProps({
      agent: "subagent",
      description: "Check continuity",
      parentTurnId: "turn-1",
      childThreadId: "child-9",
      output: { status: "error", error: { message: "Child run failed" } },
    });
    expect(failed).toMatchObject({
      agentName: "Subagent",
      status: "failed",
      childThreadId: "child-9",
      title: "Check continuity",
    });
    expect(failed).not.toHaveProperty("summary");
  });

  it("leaves an error output untouched and strips threadId from a background output", () => {
    const error = { status: "error", error: { code: "spawn_depth_exceeded" } };
    const background = {
      status: "background",
      handle: "p2",
      threadId: "child-2",
      agentSlug: "general",
    };

    expect(spawnOutputForTranscript(error)).toBe(error);
    expect(spawnOutputForTranscript(background)).toEqual({
      status: "background",
      handle: "p2",
      agentSlug: "general",
    });
  });

  it("tells the model a queued thread_message has no pushed reply", () => {
    const background = {
      status: "background",
      handle: "c1",
      threadId: "primary-1",
      agentSlug: "primary",
    };

    expect(spawnOutputForTranscript(background, { queuedNoReply: true })).toEqual({
      status: "background",
      handle: "c1",
      agentSlug: "primary",
      note: "Message queued. No reply is pushed back; the target's response is readable in its transcript.",
    });
  });
});
