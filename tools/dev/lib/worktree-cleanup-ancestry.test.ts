import { describe, expect, it, vi } from "vitest";
import { resolveAncestryRef } from "./worktree-cleanup-ancestry";

describe("resolveAncestryRef", () => {
  it("uses the remote-tracking ref when it exists", () => {
    const refExists = vi.fn((ref: string) => ref === "origin/main");

    expect(resolveAncestryRef("main", refExists)).toBe("origin/main");
    expect(refExists).toHaveBeenCalledWith("origin/main");
  });

  it("falls back to the bare base branch when there is no origin remote", () => {
    expect(resolveAncestryRef("main", () => false)).toBe("main");
  });

  it("falls back when origin lacks the base branch's remote-tracking ref", () => {
    const refExists = (ref: string) => ref === "origin/staging";

    expect(resolveAncestryRef("main", refExists)).toBe("main");
  });
});
