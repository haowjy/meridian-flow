import { describe, expect, it } from "vitest";
import { formatUsd } from "./format";

describe("formatUsd", () => {
  it("shows positive and negative sub-cent amounts instead of zero", () => {
    expect(formatUsd("0.004")).toBe("< $0.01");
    expect(formatUsd("-0.004")).toBe("-< $0.01");
  });
});
