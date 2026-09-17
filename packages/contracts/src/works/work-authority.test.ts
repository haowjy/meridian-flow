/** Resolved Work authority DTO is a Work id plus a nullable slug. */
import { describe, expect, it } from "vitest";
import { decodeWorkAuthorityDto } from "./work-authority.js";

const WORK_ID = "00000000-0000-4000-8000-000000000001";

describe("decodeWorkAuthorityDto", () => {
  it("accepts No Work as a Work id with a null slug", () => {
    expect(decodeWorkAuthorityDto({ workId: WORK_ID, workSlug: null })).toEqual({
      workId: WORK_ID,
      workSlug: null,
    });
  });

  it("accepts named Work", () => {
    expect(decodeWorkAuthorityDto({ workId: WORK_ID, workSlug: "arc" })).toEqual({
      workId: WORK_ID,
      workSlug: "arc",
    });
  });

  it("rejects missing workId or workSlug", () => {
    expect(decodeWorkAuthorityDto({ workId: WORK_ID })).toBeNull();
    expect(decodeWorkAuthorityDto({ workSlug: null })).toBeNull();
    expect(decodeWorkAuthorityDto({ kind: "none" })).toBeNull();
  });
});
