/** Major-version compatibility tests for persisted collaboration heads. */
import { describe, expect, it } from "vitest";
import { isStaleSchema } from "./stale-schema.js";

describe("persisted collaboration schema compatibility", () => {
  it("accepts a same-major head", () => {
    expect(isStaleSchema({ major: 0, minor: 2, patch: 1 }, { major: 0, minor: 1, patch: 0 })).toBe(
      false,
    );
  });

  it("rejects a major-mismatched head", () => {
    expect(isStaleSchema({ major: 1, minor: 0, patch: 0 }, { major: 0, minor: 1, patch: 0 })).toBe(
      true,
    );
  });

  it("accepts an absent head", () => {
    expect(isStaleSchema(null, { major: 0, minor: 1, patch: 0 })).toBe(false);
  });
});
