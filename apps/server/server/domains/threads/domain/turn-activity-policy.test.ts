import type { TurnOrigin } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { turnCountsAsActivity } from "./turn-activity-policy.js";

describe("turnCountsAsActivity", () => {
  it.each<[TurnOrigin, boolean]>([
    ["writer", true],
    ["assistant", true],
    ["system", false],
  ])("classifies %s turns", (origin, expected) => {
    expect(turnCountsAsActivity(origin)).toBe(expected);
  });
});
