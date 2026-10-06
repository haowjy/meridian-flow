import type { ModelThreadReportResult } from "@meridian/contracts/spawn";
import { describe, expect, it } from "vitest";
import { toolView } from "./report-test-fixtures";
import { readThreadReport } from "./thread-report-renderer";
import { isToolViewVisible } from "./tool-view-visibility";

const finished: ModelThreadReportResult = {
  ref: "p3",
  outcome: "succeeded",
  summary: "Done",
  artifacts: [{ type: "object", uri: "scratch://story.md" }],
};

describe("thread_report presentation", () => {
  it("shows as a fold step", () => {
    expect(
      isToolViewVisible(
        toolView({ toolCallId: "report-1", toolName: "thread_report", result: null }),
      ),
    ).toBe(true);
  });

  it("reads the finished report from the typed result", () => {
    expect(readThreadReport(finished)).toEqual({
      report: {
        outcome: "succeeded",
        summary: "Done",
        artifacts: [{ type: "object", uri: "scratch://story.md" }],
        partial: false,
        reason: null,
      },
      runningAgain: false,
    });
    expect(readThreadReport("p3 succeeded.\n\nDone")).toBeNull();
  });

  it("says a report is from the previous run when the subagent is running again", () => {
    const running: ModelThreadReportResult = {
      ...finished,
      running: true,
      message: "p3 is running again; this report is from its previous run.",
    };
    expect(readThreadReport(running)?.runningAgain).toBe(true);
  });
});
