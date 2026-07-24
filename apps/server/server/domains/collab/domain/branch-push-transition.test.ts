import { describe, expect, it } from "vitest";
import { detectPureDeletionOffset } from "./branch-push-transition.js";

describe("detectPureDeletionOffset", () => {
  it.each([
    ["middle deletion", "alpha brave world", "alpha world", 6],
    ["leading deletion", "brave world", "world", 0],
    ["trailing deletion", "brave world", "brave ", 6],
  ])("%s", (_case, before, after, expected) => {
    expect(detectPureDeletionOffset(before, after)).toBe(expected);
  });

  it.each([
    ["replacement", "alpha brave world", "alpha calm world"],
    ["insert-only", "alpha world", "alpha brave world"],
    ["equal text", "alpha world", "alpha world"],
    ["multiple splices", "abcdef", "ace"],
  ])("rejects %s", (_case, before, after) => {
    expect(detectPureDeletionOffset(before, after)).toBeNull();
  });
});
