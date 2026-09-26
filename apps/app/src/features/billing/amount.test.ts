import { describe, expect, it } from "vitest";

import { parseUsd, validateAmount } from "./amount";

describe("parseUsd", () => {
  it("accepts whole and two-decimal amounts", () => {
    expect(parseUsd("5")).toBe(5);
    expect(parseUsd("5.00")).toBe(5);
    expect(parseUsd("12.34")).toBe(12.34);
  });

  it("rejects empty, non-numeric, or over-precision input", () => {
    expect(parseUsd("")).toBeNull();
    expect(parseUsd("abc")).toBeNull();
    expect(parseUsd("1.234")).toBeNull();
    expect(parseUsd("-5")).toBeNull();
  });
});

describe("validateAmount", () => {
  const bounds = { minUsd: "5.00", maxUsd: "500.00" };

  it("accepts amounts within range", () => {
    expect(validateAmount("10", bounds)).toEqual({ ok: true, amountUsd: "10" });
    expect(validateAmount("5", bounds)).toEqual({ ok: true, amountUsd: "5" });
    expect(validateAmount("500", bounds)).toEqual({ ok: true, amountUsd: "500" });
  });

  it("flags out-of-range, empty, and non-numeric input", () => {
    expect(validateAmount("4.99", bounds)).toEqual({ ok: false, reason: "below-min" });
    expect(validateAmount("501", bounds)).toEqual({ ok: false, reason: "above-max" });
    expect(validateAmount("", bounds)).toEqual({ ok: false, reason: "empty" });
    expect(validateAmount("abc", bounds)).toEqual({ ok: false, reason: "non-numeric" });
  });
});
