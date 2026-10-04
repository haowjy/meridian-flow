/** `thread_report` text is a rendering of its typed result (D8); no JSON reaches the model. */
import { describe, expect, it } from "vitest";
import { renderThreadReportOutput } from "./model-thread-report.js";

describe("renderThreadReportOutput", () => {
  it("adds the reason, payload, artifacts and the running-again line", () => {
    expect(
      renderThreadReportOutput({
        ref: "p3",
        outcome: "failed",
        summary: "Stopped at the gate.",
        reason: "blocked",
        partial: true,
        source: "final_assistant",
        payload: { gate: "locked" },
        artifacts: [{ type: "object", uri: "scratch://@/notes.md", label: "Notes" }],
        running: true,
        message:
          "p3 is running again; this report is from its previous run. You'll be notified when it finishes.",
      }),
    ).toBe(`Report (failed, final_assistant)
reason: blocked
Stopped at the gate.
payload: {"gate":"locked"}
artifact: scratch://@/notes.md (Notes)

p3 is running again; this report is from its previous run. You'll be notified when it finishes.`);
  });
});
