/** Direct child results preserve the saved terminal outcome and partial content. */

import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { describe, expect, it } from "vitest";
import { savedReportToSpawnResult } from "./saved-report-outcome.js";

function saved(
  overrides: Partial<Extract<SavedExecutionReport, { outcome: string }>> = {},
): SavedExecutionReport {
  return {
    childThreadId: "child-id",
    terminalAssistantTurnId: null,
    assistantTurnId: "execution-id",
    handle: "p3",
    origin: "spawn",
    deliveryMode: "direct",
    callerThreadId: "parent-id",
    callerTurnId: "parent-turn",
    toolCallId: "spawn-call",
    cardBlockId: "card-id",
    agentSlug: "critic",
    description: null,
    capture: null,
    captureToolCallId: null,
    outcome: "succeeded",
    reason: null,
    source: "final_assistant",
    summary: "final public text",
    artifacts: null,
    costMillicredits: 42,
    terminalAt: "2026-01-01T00:00:00.000Z",
    publication: "published",
    publishedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("savedReportToSpawnResult", () => {
  it("returns exact successful execution content and cost", () => {
    expect(savedReportToSpawnResult(saved())).toEqual({
      status: "completed",
      execution: "execution-id",
      outcome: "succeeded",
      report: {
        handle: "p3",
        threadId: "child-id",
        summary: "final public text",
        costMillicredits: 42,
      },
    });
  });

  it("keeps a failed captured candidate as partial content, not success", () => {
    const result = savedReportToSpawnResult(
      saved({
        outcome: "failed",
        reason: "max_tokens",
        source: "return_result",
        summary: "partial candidate",
        payload: { retained: true },
      }),
    );
    expect(result).toMatchObject({
      status: "error",
      execution: "execution-id",
      outcome: "failed",
      partial: true,
      reason: "max_tokens",
      report: { summary: "partial candidate", payload: { retained: true } },
    });
  });

  it("keeps cancellation distinct and refuses a nonterminal row", () => {
    const cancelled = savedReportToSpawnResult(
      saved({ outcome: "cancelled", reason: "cancelled" }),
    );
    expect(cancelled).toMatchObject({
      status: "error",
      outcome: "cancelled",
      error: { code: "spawn_cancelled" },
    });
    expect(() =>
      savedReportToSpawnResult({
        ...saved(),
        outcome: null,
        source: null,
        summary: null,
        terminalAt: null,
      }),
    ).toThrow("not terminal");
  });
});
