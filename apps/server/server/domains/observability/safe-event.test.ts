/** Sanitizer boundary tests for sensitive fields and numeric gateway metrics. */
import { describe, expect, it } from "vitest";
import { unknownToEventPayload } from "./emit-event.js";
import type { EventRecord } from "./ports/event-sink.js";
import { MAX_EVENT_RECORD_BYTES, sanitizeEventRecord, serializedEventBytes } from "./safe-event.js";

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

describe("sanitizeEventRecord byte boundary", () => {
  it("replaces an oversized payload with a deterministic marker", () => {
    const event = sanitizeEventRecord({
      eventId: "event-large",
      timestamp: "2026-07-18T00:00:00.000Z",
      level: "error",
      source: "test",
      name: "test.large",
      correlation: { traceId: "trace-1", threadId: "thread-1" },
      payload: Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`field${index}`, "x".repeat(1_000)]),
      ),
    });

    expect(serializedEventBytes(event)).toBeLessThanOrEqual(MAX_EVENT_RECORD_BYTES);
    expect(event.correlation).toEqual({ traceId: "trace-1", threadId: "thread-1" });
    expect(event.payload).toMatchObject({ truncated: true, reason: "record_byte_limit" });
  });

  it("keeps the hard limit when header and correlation strings are hostile", () => {
    const huge = "x".repeat(20_000);
    const event = sanitizeEventRecord({
      eventId: huge,
      timestamp: huge,
      level: "error",
      source: huge,
      name: huge,
      correlation: {
        traceId: huge,
        runId: huge,
        parentRunId: huge,
        requestId: huge,
        threadId: huge,
        turnId: huge,
        childRunId: huge,
        agentSlug: huge,
        attemptId: huge,
        gatewayCallId: huge,
        provider: huge,
        model: huge,
        route: huge,
        method: huge,
        projectId: huge,
        workId: huge,
        toolName: huge,
        toolCallId: huge,
        errorCode: huge,
        documentId: huge,
        branchId: huge,
        yjsSpans: huge,
      },
      stream: {
        streamId: huge,
        transport: "yjs",
        observedAt: "server",
        messageClass: huge,
        observerSeq: 1,
      },
      payload: { value: huge },
    });

    expect(serializedEventBytes(event)).toBeLessThanOrEqual(MAX_EVENT_RECORD_BYTES);
  });

  it("keeps the hard limit when an untyped caller adds hostile context keys", () => {
    const extraContext = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`extra${index}`, "x".repeat(20_000)]),
    );
    const event = sanitizeEventRecord({
      eventId: "event-hostile-context",
      timestamp: "2026-07-18T00:00:00.000Z",
      level: "error",
      source: "test",
      name: "test.hostile_context",
      correlation: extraContext,
      stream: extraContext,
      payload: {},
    } as unknown as EventRecord);

    expect(serializedEventBytes(event)).toBeLessThanOrEqual(MAX_EVENT_RECORD_BYTES);
    expect(event.correlation).toBeUndefined();
    expect(event.stream).toBeUndefined();
    expect(event.payload).toMatchObject({ truncated: true, reason: "record_byte_limit" });
  });
});

describe("unknownToEventPayload", () => {
  it("keeps only allowlisted error identity and stable scalars", () => {
    const error = Object.assign(new Error("writer prose and provider text"), {
      code: "23505",
      severity: "ERROR",
      query: "select secret manuscript",
      detail: "private writer content",
      cause: new Error("provider key sk-private-private"),
    });

    const payload = unknownToEventPayload(error);

    expect(payload).toEqual({
      error: { class: "Error", category: "database", code: "23505" },
    });
    expect(JSON.stringify(payload)).not.toContain("writer");
    expect(JSON.stringify(payload)).not.toContain("query");
    expect(JSON.stringify(payload)).not.toContain("cause");
  });

  it("drops prose disguised as an error class or code", () => {
    const error = Object.assign(new Error("writer prose"), {
      name: "private writer prose",
      code: "sql",
      status: "502 bad private upstream body",
    });

    expect(unknownToEventPayload(error)).toEqual({
      error: { class: "Error", category: "unexpected" },
    });
  });
});
