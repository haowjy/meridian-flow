/** Safe-event tests: ensure ordinary observability records redact protected model/tool/secrets data. */
import { describe, expect, it } from "vitest";
import { sanitizeEventRecord } from "../safe-event.js";

describe("sanitizeEventRecord", () => {
  it("redacts sensitive keys and secret-looking strings", () => {
    const sanitized = sanitizeEventRecord({
      timestamp: "2026-06-14T00:00:00.000Z",
      level: "error",
      source: "runtime.gateway",
      name: "attempt.failed",
      payload: {
        threadId: "thread-1",
        message: "provider rejected Bearer abc.def.ghi",
        request: {
          messages: [{ role: "user", content: "patient prompt" }],
          apiKey: "sk-secretsecretsecret",
          toolArguments: { sample: "raw" },
        },
        stack: "Error: contains prompt",
      },
    });

    expect(sanitized.eventId).toEqual(expect.any(String));
    expect(sanitized.sensitivity).toBe("safe");
    expect(sanitized.payload).toMatchObject({
      threadId: "thread-1",
      message: "provider rejected [redacted-secret]",
      request: {
        messages: "[redacted]",
        apiKey: "[redacted]",
        toolArguments: "[redacted]",
      },
      stack: "[redacted]",
    });
  });
});
