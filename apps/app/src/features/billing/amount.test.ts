import { describe, expect, it } from "vitest";

import { equalsUsd, formatPreset, parseUsd, toInputValue, validateAmount } from "./amount";

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

describe("formatPreset", () => {
  it("strips trailing .00 for whole-dollar amounts", () => {
    expect(formatPreset("5.00")).toBe("$5");
    expect(formatPreset("12.50")).toBe("$12.50");
  });
});

describe("toInputValue", () => {
  it("normalises whole-dollar default for the input field", () => {
    expect(toInputValue("10.00")).toBe("10");
    expect(toInputValue("12.50")).toBe("12.5");
  });
});

describe("equalsUsd", () => {
  it("compares numeric values, not string identity", () => {
    expect(equalsUsd("5.00", "5")).toBe(true);
    expect(equalsUsd("5", "5.01")).toBe(false);
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
