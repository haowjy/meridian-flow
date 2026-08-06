/** Model-request route selection returns only matches plus required prefix context. */
import type { ModelRequestDebugRecord } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  parseModelRequestDebugQuery,
  selectModelRequestDebugRecords,
} from "./model-request-debug-route.js";

function record(turnId: string, iteration: number): ModelRequestDebugRecord {
  return {
    schema: "meridian.model-request-debug.v1",
    gatewayCallId: `${turnId}-call-${iteration}`,
    threadId: "thread-1",
    turnId,
    iteration,
    requestedAt: new Date(iteration).toISOString(),
    agentSlug: "writer",
    requestDigest: `${turnId}-digest-${iteration}`,
    requestBytes: 1,
    capture: { status: "complete" },
    request: { messages: [] },
    skills: [],
    toolRegistrations: [],
  };
}

const records = [record("turn-1", 0), record("turn-1", 1), record("turn-2", 0)];

describe("selectModelRequestDebugRecords", () => {
  it("returns an exact call and only its adjacent predecessor", () => {
    expect(
      selectModelRequestDebugRecords(records, { gatewayCallId: "turn-1-call-1" }).map(
        (entry) => entry.gatewayCallId,
      ),
    ).toEqual(["turn-1-call-0", "turn-1-call-1"]);
  });

  it("returns the latest record with predecessor context", () => {
    expect(
      selectModelRequestDebugRecords(records.slice(0, 2), { latest: true }).map(
        (entry) => entry.iteration,
      ),
    ).toEqual([0, 1]);
  });

  it("does not substitute an unrelated record when no selector matches", () => {
    expect(selectModelRequestDebugRecords(records, { gatewayCallId: "missing" })).toEqual([]);
  });

  it("returns all available records when no narrowing selector is present", () => {
    expect(selectModelRequestDebugRecords(records, {})).toEqual(records);
  });
});

describe("parseModelRequestDebugQuery", () => {
  it("parses exact selectors and explicit latest booleans", () => {
    expect(
      parseModelRequestDebugQuery({
        turnId: "turn-1",
        gatewayCallId: "call-1",
        iteration: "2",
        latest: "false",
      }),
    ).toEqual({
      turnId: "turn-1",
      gatewayCallId: "call-1",
      iteration: 2,
      latest: false,
    });
  });

  it.each([
    [{ gatewayCallId: ["call-1", "call-2"] }, "gatewayCallId must be supplied once"],
    [{ turnId: "" }, "turnId must not be empty"],
    [{ iteration: "1.5" }, "iteration must be a non-negative integer"],
    [{ latest: "yes" }, "latest must be true, false, 1, or 0"],
  ])("rejects malformed selectors instead of broadening the query", (query, message) => {
    expect(() => parseModelRequestDebugQuery(query)).toThrow(message);
  });
});
