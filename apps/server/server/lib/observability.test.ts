/** Process observability composition retains one sink/query pair across startup and app wiring. */
import { afterEach, expect, it, vi } from "vitest";
import {
  type EventQuery,
  NoopEventSink,
  RecentEventsBuffer,
} from "../domains/observability/index.js";
import { getOrBindProcessObservability } from "./observability.js";

const OBSERVABILITY_KEY = Symbol.for("meridian.api.observability.v1");

afterEach(() => {
  Reflect.deleteProperty(globalThis, OBSERVABILITY_KEY);
});

it("returns the first bound recent-events query to later composition callers", () => {
  Reflect.deleteProperty(globalThis, OBSERVABILITY_KEY);
  const eventQuery: EventQuery = new RecentEventsBuffer();
  const first = getOrBindProcessObservability(() => ({
    sink: new NoopEventSink(),
    eventQuery,
  }));
  const createAgain = vi.fn(() => ({ sink: new NoopEventSink() }));

  const second = getOrBindProcessObservability(createAgain);

  expect(second.sink).toBe(first.sink);
  expect(second.eventQuery).toBe(eventQuery);
  expect(createAgain).not.toHaveBeenCalled();
});
