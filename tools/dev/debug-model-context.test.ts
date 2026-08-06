/** CLI argument and bounded-selection policy for model-context inspection. */
import type { ModelRequestDebugView } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  formatModelRequestViews,
  parseDebugModelContextArgs,
  selectModelRequestViews,
} from "./debug-model-context";

function view(iteration: number): ModelRequestDebugView {
  return {
    record: {
      schema: "meridian.model-request-debug.v1",
      gatewayCallId: `call-${iteration}`,
      threadId: "thread-1",
      turnId: "turn-1",
      iteration,
      requestedAt: new Date(iteration).toISOString(),
      agentSlug: "writer",
      requestDigest: `digest-${iteration}`,
      requestBytes: 10,
      capture: { status: "complete" },
      request: { messages: [] },
      skills: [],
      toolRegistrations: [],
    },
    prefix: {
      status: iteration === 0 ? "first" : "exact",
      previousRequestDigest: iteration === 0 ? null : `digest-${iteration - 1}`,
      preservedMessageCount: 0,
    },
  };
}

describe("parseDebugModelContextArgs", () => {
  it("requires a thread pivot and defaults to one readable request", () => {
    expect(parseDebugModelContextArgs(["--thread", "thread-1"])).toEqual({
      threadId: "thread-1",
      view: "readable",
      all: false,
    });
    expect(() => parseDebugModelContextArgs(["--turn", "turn-1"])).toThrow("--thread is required");
  });

  it("parses exact call selection and rejects invalid iterations", () => {
    expect(
      parseDebugModelContextArgs([
        "--thread",
        "thread-1",
        "--turn",
        "turn-1",
        "--iteration",
        "2",
        "--gateway-call",
        "call-2",
        "--view",
        "raw",
      ]),
    ).toMatchObject({ iteration: 2, gatewayCallId: "call-2", view: "raw" });
    expect(() => parseDebugModelContextArgs(["--thread", "thread-1", "--iteration", "-1"])).toThrow(
      "non-negative integer",
    );
  });
});

describe("selectModelRequestViews", () => {
  const views = [view(0), view(1), view(2)];

  it("returns only the latest request by default", () => {
    expect(selectModelRequestViews(views, { all: false })[0]?.record.iteration).toBe(2);
  });

  it("supports all and exact-call selection", () => {
    expect(selectModelRequestViews(views, { all: true })).toHaveLength(3);
    expect(
      selectModelRequestViews(views, { all: false, gatewayCallId: "call-1" })[0]?.record.iteration,
    ).toBe(1);
  });

  it("puts requested content before debug evidence in readable and raw views", () => {
    const selected = [view(1)];

    expect(Object.keys(formatModelRequestViews(selected, "readable")[0] ?? {})).toEqual([
      "markdown",
      "debug",
    ]);
    expect(Object.keys(formatModelRequestViews(selected, "raw")[0] ?? {})).toEqual([
      "request",
      "debug",
    ]);
    expect(formatModelRequestViews(selected, "summary")[0]).toMatchObject({
      iteration: 1,
      messageCount: 0,
      prefix: { status: "exact", appendedMessageCount: 0 },
    });
  });
});
