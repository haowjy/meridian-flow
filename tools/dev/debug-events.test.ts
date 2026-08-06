/** Debug-event CLI argument policy keeps local agent queries narrow and bounded. */
import { describe, expect, it } from "vitest";
import { parseDebugEventsArgs } from "./debug-events";
import { createBoundedResponseCollector } from "./debug-http-client";

describe("parseDebugEventsArgs", () => {
  it("maps a correlation pivot and compact defaults", () => {
    expect(parseDebugEventsArgs(["--trace", "trace-1", "--level", "error"])).toEqual({
      full: false,
      query: { traceId: "trace-1", level: "error", limit: 50 },
    });
  });

  it("caps compact and full output independently", () => {
    expect(parseDebugEventsArgs(["--event", "event-1", "--limit", "500"]).query.limit).toBe(50);
    expect(
      parseDebugEventsArgs(["--event", "event-1", "--limit", "500", "--full"]).query.limit,
    ).toBe(200);
  });

  it("rejects an unbounded query", () => {
    expect(() => parseDebugEventsArgs(["--source", "collab"])).toThrow(
      "A narrowing pivot is required",
    );
  });
});

describe("createBoundedResponseCollector", () => {
  it("rejects a response as soon as its cumulative byte ceiling is exceeded", () => {
    const collector = createBoundedResponseCollector(5);
    collector.push("123");

    expect(() => collector.push("456")).toThrow("5-byte safety limit");
  });
});
