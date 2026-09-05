/** Working-set route parsing protects the scheme/work authority wire invariant. */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { WorkId } from "../ids.js";
import type {
  CreateThreadRequest,
  DeleteContextEntryRequest,
  DeleteContextEntryResult,
} from "./http-types.js";
import { parseWorkingSetRoute, parseWorkingSetRouteList } from "./http-types.js";

describe("context deletion result", () => {
  it("requires the initiating kind and file identity", () => {
    expectTypeOf<DeleteContextEntryRequest>().toEqualTypeOf<
      | { path: string; expected: { kind: "file"; documentId: string } }
      | { path: string; expected: { kind: "folder" } }
    >();
  });
  it("carries an exact batch of committed document identities", () => {
    expectTypeOf<DeleteContextEntryResult>().toEqualTypeOf<{
      status: "deleted";
      deletedDocumentIds: string[];
      availabilityGeneration: string;
    }>();
  });
});

describe("root thread creation", () => {
  it("preserves omitted, explicit null, and real Work identity", () => {
    expectTypeOf<CreateThreadRequest["workId"]>().toEqualTypeOf<WorkId | null | undefined>();
  });
});

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

  it("rejects invalid paths and invalid list entries", () => {
    expect(parseWorkingSetRoute({ scheme: "kb", path: "" }).ok).toBe(false);
    expect(parseWorkingSetRoute({ scheme: "kb", path: "x".repeat(1025) }).ok).toBe(false);
    expect(parseWorkingSetRouteList([{ scheme: "unknown", path: "/" }]).ok).toBe(false);
  });
});
