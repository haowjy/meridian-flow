/** Canonical project-read path resolution, including explicit no-Work authority. */
import { describe, expect, it } from "vitest";
import { resolveContextReadPath } from "./context-read-route.js";

describe("resolveContextReadPath", () => {
  it("round trips an explicit no-Work Scratch URI", () => {
    expect(resolveContextReadPath("scratch", "scratch://@/notes.md", { kind: "none" })).toEqual({
      uri: "scratch://@/notes.md",
      path: "/@/notes.md",
    });
  });

  it("applies resolved no-Work authority to contextual Scratch input", () => {
    expect(resolveContextReadPath("scratch", "notes.md", { kind: "none" })).toEqual({
      uri: "scratch://@/notes.md",
      path: "/@/notes.md",
    });
  });

  it("rejects an explicit authority that conflicts with the route", () => {
    expect(() =>
      resolveContextReadPath("scratch", "scratch://@other/notes.md", { kind: "none" }),
    ).toThrow("Context authority does not match route");
  });
});
