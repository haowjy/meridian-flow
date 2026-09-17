/** Resolved Work authority DTO accepts named Work and No Work with an id. */
import { describe, expect, it } from "vitest";
import { decodeWorkAuthorityDto } from "./work-authority.js";
import { decodeWorkSlug } from "./work-slug.js";

const WORK_ID = "00000000-0000-4000-8000-000000000001";
const SLUG = decodeWorkSlug("fight-scene");

describe("decodeWorkAuthorityDto", () => {
  it("accepts a named Work projection", () => {
    expect(decodeWorkAuthorityDto({ kind: "work", workId: WORK_ID, workSlug: SLUG })).toEqual({
      kind: "work",
      workId: WORK_ID,
      workSlug: SLUG,
    });
  });

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
