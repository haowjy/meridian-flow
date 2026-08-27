import { describe, expect, it } from "vitest";
import { formatProjectChatActivity } from "./project-chat-activity-date";

describe("formatProjectChatActivity", () => {
  const now = Date.parse("2026-08-13T12:00:00Z");
  it.each([
    ["2026-08-13T11:59:30Z", "now"],
    ["2026-08-13T11:46:00Z", "14m"],
    ["2026-08-13T09:00:00Z", "3h"],
    ["2026-08-09T12:00:00Z", "4d"],
  ])("formats %s", (value, expected) =>
    expect(formatProjectChatActivity(value, now, "en-US")).toBe(expected));
  it("uses compact absolute dates after a week", () => {
    expect(formatProjectChatActivity("2026-08-06T12:00:00Z", now, "en-US")).toBe("Aug 6");
    expect(formatProjectChatActivity("2025-08-06T12:00:00Z", now, "en-US")).toBe("Aug 6, 2025");
  });
});
