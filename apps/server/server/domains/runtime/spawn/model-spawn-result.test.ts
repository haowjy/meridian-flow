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

  it("tells the model a background run will report back", () => {
    expect(
      render({
        status: "background",
        execution: "execution-2" as never,
        handle: "p2",
        threadId: "child-2",
        agentSlug: "critic",
      }),
    ).toBe("p2 is running in the background. You'll be notified when it finishes.");
  });

  it("tells the model whether a queued message reports back", () => {
    const queued = { status: "background" as const, threadId: "t", agentSlug: "critic" };
    expect(render({ ...queued, handle: "p3", notifiesCaller: true })).toBe(
      "Message queued. You'll be notified when p3 finishes.",
    );
    expect(render({ ...queued, handle: "c1", notifiesCaller: false })).toBe(
      "Message queued. No reply is pushed back; the target's response is readable in its transcript.",
    );
  });

  it("never shows internal ids", () => {
    const text = render({
      status: "completed",
      execution: "execution-2" as never,
      outcome: "succeeded",
      report,
    });
    expect(text).not.toContain("execution-2");
    expect(text).not.toContain("child-2");
  });
});
