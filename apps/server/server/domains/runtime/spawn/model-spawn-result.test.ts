import type { SpawnResult } from "@meridian/contracts/spawn";
import type { JsonValue } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { renderSpawnOutput } from "./model-spawn-result.js";
import { renderThreadReportOutput } from "./model-thread-report.js";

const render = (result: SpawnResult) => renderSpawnOutput(result as unknown as JsonValue);
const report = {
  handle: "p2",
  threadId: "child-2",
  source: "return_result" as const,
  summary: "Chapter 3 is consistent.\nOne slip in scene 2.",
};

describe("renderSpawnOutput", () => {
  it("renders a finished report as thread_report does, under the child's handle", () => {
    const text = render({
      status: "completed",
      execution: "execution-2" as never,
      outcome: "succeeded",
      report: {
        ...report,
        payload: { slips: 1 },
        artifacts: [{ type: "object" as const, uri: "manuscript://ch3.md" }],
      },
    });
    const reportBlock = renderThreadReportOutput({
      ref: "p2",
      outcome: "succeeded",
      summary: report.summary,
      payload: { slips: 1 },
      artifacts: [{ type: "object" as const, uri: "manuscript://ch3.md" }],
    });
    expect(text).toBe(`Subagent p2\n${reportBlock}`);
  });
});
