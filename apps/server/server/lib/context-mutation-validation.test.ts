/** Shared writer-mutation validation verdicts. */

import { describe, expect, it } from "vitest";
import {
  parseContextMutationName,
  parseContextMutationPath,
} from "./context-mutation-validation.js";

describe("context mutation validation", () => {
  it.each([
    ["name", () => parseContextMutationName("bad:name.md", "newName")],
    ["path segment", () => parseContextMutationPath("Drafts/bad:name.md", "path")],
  ])("returns the contracts reason code for an invalid %s", (_label, parse) => {
    expect(parse).toThrowError(
      expect.objectContaining({
        status: 400,
        data: expect.objectContaining({ reason: "name/invalid-character", character: ":" }),
      }),
    );
  });

  it("normalizes every segment with the contracts policy", () => {
    expect(parseContextMutationPath(" Act 1 / Opening.md ", "path")).toBe("Act 1/Opening.md");
  });

  it("allows a root only when the mutation field explicitly does", () => {
    expect(parseContextMutationPath("", "folderPath", { allowRoot: true })).toBe("");
    expect(() => parseContextMutationPath("", "path")).toThrowError(
      expect.objectContaining({ data: expect.objectContaining({ reason: "path/empty-segment" }) }),
    );
  });
});
