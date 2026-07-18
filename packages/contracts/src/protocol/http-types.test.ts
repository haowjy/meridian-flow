/** Working-set route parsing protects the scheme/work authority wire invariant. */
import { describe, expect, it } from "vitest";
import { parseWorkingSetRoute, parseWorkingSetRouteList } from "./http-types.js";

describe("working-set route parser", () => {
  it("accepts each valid union arm", () => {
    expect(parseWorkingSetRoute({ scheme: "manuscript", path: "/chapter.md" })).toEqual({
      ok: true,
      value: { scheme: "manuscript", path: "/chapter.md" },
    });
    expect(
      parseWorkingSetRoute({ scheme: "scratch", path: "/notes.md", workId: "work-1" }),
    ).toEqual({
      ok: true,
      value: { scheme: "scratch", path: "/notes.md", workId: "work-1" },
    });
  });

  it("enforces workId pairing in both directions", () => {
    expect(parseWorkingSetRoute({ scheme: "scratch", path: "/notes.md" }).ok).toBe(false);
    expect(
      parseWorkingSetRoute({ scheme: "manuscript", path: "/chapter.md", workId: "work-1" }).ok,
    ).toBe(false);
  });

  it("rejects invalid paths and invalid list entries", () => {
    expect(parseWorkingSetRoute({ scheme: "kb", path: "" }).ok).toBe(false);
    expect(parseWorkingSetRoute({ scheme: "kb", path: "x".repeat(1025) }).ok).toBe(false);
    expect(parseWorkingSetRouteList([{ scheme: "unknown", path: "/" }]).ok).toBe(false);
  });
});
