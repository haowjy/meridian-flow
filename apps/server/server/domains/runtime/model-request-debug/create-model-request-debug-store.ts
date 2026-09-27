/**
 * Composition helper: in-memory capture when the composition root enables debug
 * paths, noop otherwise. The gate itself lives at the composition boundary.
 */
import { type EventSink, emitEvent } from "../../observability/index.js";
import { createInMemoryModelRequestDebugStore } from "./adapters/in-memory/in-memory-model-request-debug-store.js";
import { createNoopModelRequestDebugStore } from "./adapters/noop/noop-model-request-debug-store.js";
import type { ModelRequestDebugStore } from "./ports/model-request-debug-store.js";

let startupLogged = false;

export function createModelRequestDebugStore(input: {
  enabled: boolean;
  eventSink?: EventSink;
}): ModelRequestDebugStore {
  if (!input.enabled) return createNoopModelRequestDebugStore();

  if (!startupLogged) {
    if (input.eventSink) {
      emitEvent(input.eventSink, {
        level: "info",
        source: "runtime.model_request_debug",
        name: "capture.enabled",
        payload: {},
      });
    }
    startupLogged = true;
  }

  return createInMemoryModelRequestDebugStore();
}
