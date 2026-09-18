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
      agentName: "Helper",
      status: "running",
      childThreadId: "",
      title: "Continuity",
    });
    const done = spawnHelperCardProps({
      agent: "critic",
      parentTurnId: "turn-1",
      output: {
        status: "completed",
        report: { threadId: "child-1", summary: "Holds.", costMillicredits: 9 },
      },
    });
    expect(done).toMatchObject({
      agentName: "Critic",
      status: "completed",
      summary: "Holds.",
      childThreadId: "child-1",
    });
    expect(JSON.stringify(done)).not.toContain("cost");
  });

  it("leaves error and background outputs untouched", () => {
    const error = { status: "error", error: { code: "spawn_depth_exceeded" } };
    const background = { status: "background", threadId: "child-2" };

    expect(spawnOutputForTranscript(error)).toBe(error);
    expect(spawnOutputForTranscript(background)).toBe(background);
  });
});
