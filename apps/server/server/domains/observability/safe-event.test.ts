/** Sanitizer boundary tests for sensitive fields and numeric gateway metrics. */
import { describe, expect, it } from "vitest";
import { sanitizeEventRecord } from "./safe-event.js";

function sanitize(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizeEventRecord({
    eventId: "event-1",
    timestamp: "2026-07-18T00:00:00.000Z",
    level: "info",
    source: "test",
    name: "test.event",
    payload,
  }).payload;
}

const metricKeys = ["firstOutputMs", "inputTokens", "outputTokens"] as const;

describe("sanitizeEventRecord numeric metrics", () => {
  it.each(metricKeys)("preserves finite numbers under %s", (key) => {
    expect(sanitize({ [key]: 42.5 })).toEqual({ [key]: 42.5 });
  });

  it.each([
    ["string", "entire manuscript"],
    ["array", ["private"]],
    ["object", { private: true }],
    ["bigint", 42n],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("redacts %s values under every metric key", (_shape, value) => {
    expect(sanitize(Object.fromEntries(metricKeys.map((key) => [key, value])))).toEqual(
      Object.fromEntries(metricKeys.map((key) => [key, "[redacted]"])),
    );
  });

  it("redacts the probed metric-key payloads at every depth", () => {
    expect(
      sanitize({
        inputTokens: "entire manuscript",
        firstOutputMs: ["private"],
        audit: { inputTokens: "customer input" },
      }),
    ).toEqual({
      inputTokens: "[redacted]",
      firstOutputMs: "[redacted]",
      audit: { inputTokens: "[redacted]" },
    });
  });
});
