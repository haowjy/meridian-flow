import type { Block } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));

import type { ToolView } from "./group-delivery-segments";
import { spawnReportFromTool } from "./spawn-report";

const keyBlock: Block = {
  id: "block-0",
  turnId: "turn-1",
  responseId: null,
  blockType: "tool_use",
  sequence: 0,
  content: null,
  status: "complete",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function toolView(overrides: Partial<ToolView>): ToolView {
  return {
    toolCallId: "call-1",
    toolName: "spawn",
    input: null,
    output: null,
    status: "complete",
    isError: false,
    message: null,
    streamedOutput: null,
    metadata: null,
    keyBlock,
    ...overrides,
  };
}

describe("spawnReportFromTool", () => {
  it("reads who ran and the report, never the cost", () => {
    const report = spawnReportFromTool(
      toolView({
        input: { prompt: "check", agent: "critic", description: "Continuity check" },
        output: {
          status: "completed",
          report: {
            threadId: "child-1",
            summary: "Everything holds.",
            costMillicredits: 73,
          },
        },
      }),
    );

    expect(report).toEqual({
      agentName: "Critic",
      title: "Continuity check",
      summary: "Everything holds.",
      status: "completed",
      childThreadId: "child-1",
    });
    expect(JSON.stringify(report)).not.toContain("cost");
    expect(JSON.stringify(report)).not.toContain("73");
  });

  it("names the generic helper when the agent is omitted", () => {
    const report = spawnReportFromTool(
      toolView({
        input: { prompt: "2+2" },
        output: { status: "background", threadId: "child-2", agentSlug: "helper" },
      }),
    );

    expect(report?.agentName).toBe("Helper");
    expect(report?.status).toBe("running");
    expect(report?.childThreadId).toBe("child-2");
  });

  it("uses the existing failure verb for an errored spawn with no child door", () => {
    const report = spawnReportFromTool(
      toolView({
        isError: true,
        output: { status: "error", error: { code: "spawn_depth_exceeded", message: "too deep" } },
      }),
    );

    expect(report?.status).toBe("failed");
    expect(report?.summary).toBe("Couldn't finish that step");
    expect(report?.childThreadId).toBeNull();
  });

  it("shows a running card while spawn has no result yet", () => {
    const report = spawnReportFromTool(toolView({ input: { prompt: "check" }, output: null }));
    expect(report).toEqual({
      agentName: "Helper",
      title: null,
      summary: null,
      status: "running",
      childThreadId: null,
    });
  });

  it("ignores non-spawn tools", () => {
    expect(spawnReportFromTool(toolView({ toolName: "write" }))).toBeNull();
  });
});
