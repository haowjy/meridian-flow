import { describe, expect, it } from "vitest";
import { toolView } from "./report-test-fixtures";
import { threadReportContent } from "./thread-report-renderer";
import { isToolViewVisible } from "./tool-view-visibility";

describe("thread_report presentation", () => {
  it("shows as a fold step", () => {
    expect(
      isToolViewVisible(
        toolView({ toolCallId: "report-1", toolName: "thread_report", output: null }),
      ),
    ).toBe(true);
  });

  it("reads the saved report, or nothing when it isn't ready", () => {
    expect(
      threadReportContent({
        outcome: "succeeded",
        summary: "Done",
        artifacts: [{ type: "object", uri: "scratch://story.md" }],
        partial: false,
      }),
    ).toEqual({
      outcome: "succeeded",
      summary: "Done",
      artifacts: [{ type: "object", uri: "scratch://story.md" }],
      partial: false,
    });
    expect(threadReportContent({ ref: "p3", status: "not_ready" })).toBeNull();
  });
});
