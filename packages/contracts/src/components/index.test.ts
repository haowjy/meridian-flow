/** Interrupt answer normalization removes exactly one envelope. */
import { describe, expect, it } from "vitest";

import { normalizeInterruptAnswerValue } from "./index.js";

describe("normalizeInterruptAnswerValue", () => {
  it("unwraps exactly one interrupt answer envelope", () => {
    expect(normalizeInterruptAnswerValue("direct")).toBe("direct");
    expect(normalizeInterruptAnswerValue({ value: "wrapped" })).toBe("wrapped");
    expect(normalizeInterruptAnswerValue({ value: { value: "nested" } })).toBe(
      JSON.stringify({ value: "nested" }),
    );
  });
});
