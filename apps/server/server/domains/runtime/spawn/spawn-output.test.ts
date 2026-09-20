import { describe, expect, it } from "vitest";

import { spawnHelperCardProps, spawnOutputForTranscript } from "./spawn-output.js";

describe("spawnOutputForTranscript", () => {
  it("drops cost from a completed report and keeps the rest", () => {
    const output = spawnOutputForTranscript({
      status: "completed",
      report: {
        threadId: "child-1",
        summary: "Stated that 2+2=4.",
        payload: { answer: 4 },
        costMillicredits: 69,
      },
    });

    expect(output).toEqual({
      status: "completed",
      report: {
        threadId: "child-1",
        summary: "Stated that 2+2=4.",
        payload: { answer: 4 },
      },
    });
    expect(JSON.stringify(output)).not.toContain("cost");
  });

  it("builds a running helper card then a completed one without cost", () => {
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
      summary: "Holds.",
      childThreadId: "child-1",
      payload: { verdict: "ok" },
    });
    expect(JSON.stringify(done)).not.toContain("cost");
  });

  it("carries report artifacts onto the completed card without cost", () => {
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

    expect(done.artifacts).toEqual([
      { type: "object", uri: "scratch://outline.md", label: "Outline" },
    ]);
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
      summary: "Child run failed",
      childThreadId: "child-9",
      title: "Check continuity",
    });
  });

  it("leaves error and background outputs untouched", () => {
    const error = { status: "error", error: { code: "spawn_depth_exceeded" } };
    const background = { status: "background", threadId: "child-2" };

    expect(spawnOutputForTranscript(error)).toBe(error);
    expect(spawnOutputForTranscript(background)).toBe(background);
  });
});
