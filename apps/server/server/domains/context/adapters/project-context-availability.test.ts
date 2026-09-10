/** Project-final availability request boundary tests. */
import { describe, expect, it } from "vitest";
import { normalizeAvailabilityDocumentIds } from "./project-context-availability.js";

describe("project context availability request boundary", () => {
  it("deduplicates stable IDs while preserving first-request order", () => {
    expect(normalizeAvailabilityDocumentIds(["b", "a", "b"])).toEqual(["b", "a"]);
  });

  it("rejects a 129th distinct ID before opening a snapshot", () => {
    const ids = Array.from({ length: 129 }, (_, index) => String(index));
    expect(() => normalizeAvailabilityDocumentIds(ids)).toThrow(/at most 128/);
  });

  it("accepts 128 distinct IDs", () => {
    const ids = Array.from({ length: 128 }, (_, index) => String(index));
    expect(normalizeAvailabilityDocumentIds(ids)).toHaveLength(128);
  });
});
