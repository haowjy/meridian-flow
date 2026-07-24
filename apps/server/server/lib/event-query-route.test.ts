/** Recent-events route filter parsing tests. */
import { describe, expect, it } from "vitest";
import { parseEventQueryFilter } from "./event-query-route.js";

describe("parseEventQueryFilter", () => {
  it("maps event fields and correlation keys with numeric equality types", () => {
    expect(
      parseEventQueryFilter({
        source: "wire.yjs",
        name: "socket.",
        excludeName: "socket.chunk",
        level: "warn",
        documentId: "doc-1",
        threadId: "thread-1",
        branchGeneration: "4",
        sinceEventId: "cursor",
        sinceTimestamp: "2026-07-18T00:00:00Z",
        limit: "50",
      }),
    ).toEqual({
      source: "wire.yjs",
      name: "socket.",
      excludeName: "socket.chunk",
      level: "warn",
      correlation: { documentId: "doc-1", threadId: "thread-1", branchGeneration: 4 },
      sinceEventId: "cursor",
      sinceTimestamp: "2026-07-18T00:00:00.000Z",
      limit: 50,
    });
  });

  it("clamps the limit to 1,000", () => {
    expect(parseEventQueryFilter({ limit: "50000" }).limit).toBe(1_000);
  });

  it.each([
    { limit: "0" },
    { limit: "1.5" },
    { level: "verbose" },
    { yjsClient: "x" },
  ])("rejects invalid query %#", (query) => {
    expect(() => parseEventQueryFilter(query)).toThrow();
  });
});
