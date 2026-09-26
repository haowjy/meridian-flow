/** Working-set route parsing protects the scheme/work authority wire invariant. */
import { describe, expect, it } from "vitest";
import { parseWorkingSetRoute, parseWorkingSetRouteList } from "./http-types.js";

describe("working-set route parser", () => {
  it("accepts each valid union arm", () => {
    const documentId = "00000000-0000-0000-0000-000000000001";
    expect(parseWorkingSetRoute({ documentId, scheme: "manuscript", path: "/chapter.md" })).toEqual(
      {
        ok: true,
        value: { documentId, scheme: "manuscript", path: "/chapter.md" },
      },
    );
    expect(
      parseWorkingSetRoute({ documentId, scheme: "scratch", path: "/notes.md", workId: null }),
    ).toEqual({
      ok: true,
      value: { documentId, scheme: "scratch", path: "/notes.md", workId: null },
    });
  });

  it("rejects locator-only and malformed document identities", () => {
    expect(parseWorkingSetRoute({ scheme: "manuscript", path: "/chapter.md" }).ok).toBe(false);
    expect(
      parseWorkingSetRoute({ documentId: "not-a-uuid", scheme: "manuscript", path: "/chapter.md" })
        .ok,
    ).toBe(false);
  });

  it("enforces workId pairing in both directions", () => {
    const documentId = "00000000-0000-0000-0000-000000000001";
    expect(parseWorkingSetRoute({ documentId, scheme: "scratch", path: "/notes.md" }).ok).toBe(
      false,
    );
    expect(
      parseWorkingSetRoute({ documentId, scheme: "manuscript", path: "/chapter.md", workId: null })
        .ok,
    ).toBe(false);
  });

  it("rejects invalid paths and invalid list entries at their intended guards", () => {
    const validRoute = {
      documentId: "00000000-0000-0000-0000-000000000001",
      scheme: "manuscript" as const,
      path: "/chapter.md",
    };

    expect(parseWorkingSetRoute({ ...validRoute, path: "" })).toEqual({
      ok: false,
      message: "Working-set route path must contain 1 to 1024 characters",
    });
    expect(parseWorkingSetRoute({ ...validRoute, path: "x".repeat(1025) })).toEqual({
      ok: false,
      message: "Working-set route path must contain 1 to 1024 characters",
    });
    expect(parseWorkingSetRoute({ ...validRoute, path: "x".repeat(1024) }).ok).toBe(true);
    expect(parseWorkingSetRoute({ ...validRoute, scheme: "unknown" })).toEqual({
      ok: false,
      message: "Working-set route has an unknown scheme",
    });
    expect(parseWorkingSetRouteList([{ ...validRoute, scheme: "unknown" }])).toEqual({
      ok: false,
      message: "Working-set route has an unknown scheme",
    });
  });
});
