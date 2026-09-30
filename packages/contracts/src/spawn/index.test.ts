import { describe, expect, it } from "vitest";
import {
  parseSubagentUpdateMetadata,
  parseThreadReportResult,
  toReportContentValue,
} from "./index.js";

describe("subagent update metadata", () => {
  it("requires durable child identity and display name", () => {
    expect(
      parseSubagentUpdateMetadata({
        kind: "subagent_update",
        handle: "p4",
        execution: "execution-1",
        outcome: "succeeded",
        childThreadId: "child-1",
        agentName: "Continuity checker",
      }),
    ).toEqual({
      kind: "subagent_update",
      handle: "p4",
      execution: "execution-1",
      outcome: "succeeded",
      childThreadId: "child-1",
      agentName: "Continuity checker",
    });
    expect(
      parseSubagentUpdateMetadata({
        kind: "subagent_update",
        handle: "p4",
        execution: "execution-1",
        outcome: "succeeded",
      }),
    ).toBeNull();
  });
});

describe("thread report wire contract", () => {
  it("parses the shared tool/API result and maps one report body shape", () => {
    const saved = {
      childThreadId: "child-1",
      ref: "p4",
      run: 1,
      outcome: "failed",
      deliveryMode: "background_notification",
      source: "return_result",
      summary: "The outline is partial.",
      payload: { chapter: 4 },
      artifacts: [{ type: "object", uri: "scratch://outline.md" }],
      partial: true,
      reason: "budget_exhausted",
    };
    const result = parseThreadReportResult(saved);

    expect(result).toEqual(saved);
    expect(toReportContentValue(result)).toEqual({
      summary: "The outline is partial.",
      payload: { chapter: 4 },
      artifacts: [{ type: "object", uri: "scratch://outline.md" }],
      partial: true,
      outcome: "failed",
      reason: "budget_exhausted",
    });
  });

  it("returns no body for an unavailable result and rejects malformed saved content", () => {
    const unavailable = parseThreadReportResult({
      childThreadId: "child-1",
      ref: "p4",
      status: "unavailable",
    });
    expect(toReportContentValue(unavailable)).toBeNull();
    expect(parseThreadReportResult({ childThreadId: "child-1", ref: "p4", summary: "bad" })).toBe(
      null,
    );
  });

  it("parses the compact model tool result", () => {
    const result = parseThreadReportResult({
      ref: "p4",
      run: 1,
      outcome: "succeeded",
      summary: "The outline is ready.",
    });
    expect(toReportContentValue(result)).toEqual({
      summary: "The outline is ready.",
      artifacts: [],
      partial: false,
      outcome: "succeeded",
      reason: null,
    });
  });
});

it("parses a structured report authorization error without presenting it as a saved report", () => {
  const error = {
    ok: false,
    error: {
      code: "thread_not_connected",
      message: "Not connected",
      source: "system",
      retryable: false,
    },
  };
  expect(parseThreadReportResult(error)).toEqual(error);
  expect(toReportContentValue(parseThreadReportResult(error))).toBeNull();
});
