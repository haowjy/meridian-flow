import { describe, expect, it } from "vitest";
import { formatHomeActivity } from "./HomeScreen";

describe("formatHomeActivity", () => {
  const now = Date.parse("2026-08-13T12:00:00Z");
  it.each([
    ["2026-08-13T11:59:30Z", "now"],
    ["2026-08-13T11:46:00Z", "14m"],
    ["2026-08-13T09:00:00Z", "3h"],
    ["2026-08-09T12:00:00Z", "4d"],
  ])("formats %s", (value, expected) =>
    expect(formatHomeActivity(value, now, "en-US")).toBe(expected));
  it("uses compact absolute dates after a week", () => {
    expect(formatHomeActivity("2026-08-06T12:00:00Z", now, "en-US")).toBe("Aug 6");
    expect(formatHomeActivity("2025-08-06T12:00:00Z", now, "en-US")).toBe("Aug 6, 2025");
  });
});
