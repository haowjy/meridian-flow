import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { describe, expect, it } from "vitest";
import { destination, isDrafted } from "./policy.js";

describe("file policy", () => {
  it("drafts project sources and never scratch or uploads", () => {
    expect(CONTEXT_URI_SCHEMES.filter(isDrafted)).toEqual(["manuscript", "kb", "user", "unfiled"]);
  });

  it("routes drafted sources to the draft only in draft mode", () => {
    for (const scheme of CONTEXT_URI_SCHEMES) {
      expect(destination(scheme, false)).toBe("live");
      expect(destination(scheme, true)).toBe(isDrafted(scheme) ? "draft" : "live");
    }
  });
});
