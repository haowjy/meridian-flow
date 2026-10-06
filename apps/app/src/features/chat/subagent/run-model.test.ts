import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { buildSubagentRuns, indexSubagentRuns, statusFromSources } from "./run-model";

describe("saved and live run status", () => {
  it("never treats a saved running card without a live lease as still running", () => {
    expect(statusFromSources({ savedRunning: true, endedAt: "2026-09-26T00:00:00Z" })).toBe(
      "unknown",
    );
    expect(statusFromSources({ savedRunning: true })).toBe("unknown");
  });

  it("uses terminal truth before a potentially stale live lease", () => {
    expect(statusFromSources({ outcome: "succeeded", live: true })).toBe("done");
    expect(statusFromSources({ outcome: "failed", live: true })).toBe("stopped");
    expect(statusFromSources({ live: true })).toBe("running");
  });

  it("keeps unrecognized lifecycle information neutral", () => {
    expect(statusFromSources({})).toBe("unknown");
    expect(statusFromSources({ outcome: "pending" })).toBe("unknown");
  });
});

describe("subagent runs from saved turns", () => {
  it("keeps the launch card's identity on the finished notice without activity", () => {
    const launch = {
      id: "turn-launch",
      threadId: "parent",
      role: "assistant",
      metadata: null,
      completedAt: "2026-09-27T00:00:10Z",
      blocks: [
        {
          id: "card",
          blockType: "custom",
          content: {
            kind: "helper-result",
            props: {
              agentSlug: "subagent",
              agentName: "Subagent",
              parentTurnId: "turn-launch",
              toolCallId: "call-1",
              deliveryMode: "background_notification",
              startedAt: "2026-09-27T00:00:00Z",
              title: "Glass tide scene",
              childThreadId: "child-1",
              execution: "exec-1",
              terminalAt: "2026-09-27T00:01:00Z",
              outcome: "succeeded",
            },
          },
        },
      ],
    };
    const notice = {
      id: "turn-notice",
      threadId: "parent",
      role: "assistant",
      completedAt: "2026-09-27T00:01:05Z",
      blocks: [],
      metadata: {
        kind: "subagent_update",
        handle: "p7",
        execution: "exec-1",
        outcome: "succeeded",
        childThreadId: "child-1",
        agentName: "Subagent",
      },
    };
    const runs = indexSubagentRuns(buildSubagentRuns([], [launch, notice] as unknown as Turn[]));

    expect(runs.byRef.get("p7")).toMatchObject({
      name: "Glass tide scene",
      originTurnId: "turn-launch",
      startedAt: "2026-09-27T00:00:00Z",
      deliveryMode: "background_notification",
      status: "done",
    });
  });
});
