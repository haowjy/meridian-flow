/** Resolved Work authority DTO requires a Work id for No Work. */
import { describe, expect, it } from "vitest";
import { decodeWorkAuthorityDto } from "./work-authority.js";

const WORK_ID = "00000000-0000-4000-8000-000000000001";

describe("decodeWorkAuthorityDto", () => {
  it("accepts resolved No Work with a Work id", () => {
    expect(decodeWorkAuthorityDto({ kind: "none", workId: WORK_ID })).toEqual({
      kind: "none",
      workId: WORK_ID,
    });
  });

  it("rejects parse-only none without a Work id", () => {
    expect(decodeWorkAuthorityDto({ kind: "none" })).toBeNull();
  });
});
