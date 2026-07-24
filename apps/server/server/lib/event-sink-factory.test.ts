/** Event-sink composition tests for provider and recent-query gating. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoopEventSink, RecentEventsBuffer, TeeEventSink } from "../domains/observability/index.js";
import { createEventSinkFromEnv } from "./event-sink-factory.js";

afterEach(() => vi.unstubAllEnvs());

describe("createEventSinkFromEnv", () => {
  it("tees a local development sink into the recent-events buffer", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EVENT_PROVIDER", "local");
    vi.stubEnv("LOG_DIR", "");

    const composition = createEventSinkFromEnv();

    expect(composition.sink).toBeInstanceOf(TeeEventSink);
    expect(composition.eventQuery).toBeInstanceOf(RecentEventsBuffer);
  });

  it("never exposes recent events for a production local sink", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVENT_PROVIDER", "local");
    vi.stubEnv("RECENT_EVENTS", "1");

    expect(createEventSinkFromEnv().eventQuery).toBeUndefined();
  });

  it("does not compose a buffer for the disabled provider", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EVENT_PROVIDER", "none");

    const composition = createEventSinkFromEnv();

    expect(composition.sink).toBeInstanceOf(NoopEventSink);
    expect(composition.eventQuery).toBeUndefined();
  });
});
