import { describe, expect, it } from "vitest";
import { toolView } from "./report-test-fixtures";
import { isToolViewVisible } from "./tool-view-visibility";

describe("thread_report presentation", () => {
  it("is hidden from the process fold because partitionTurn owns the report artifact", () => {
    expect(
      isToolViewVisible(
        toolView({ toolCallId: "report-1", toolName: "thread_report", output: null }),
      ),
    ).toBe(false);
  });
});
