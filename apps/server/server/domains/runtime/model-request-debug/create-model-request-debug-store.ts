/**
 * Composition helper: pick in-memory capture vs noop from the typed env gate
 * (`modelRequestDebugCaptureEnabled` in `lib/env.ts`).
 */
import { modelRequestDebugCaptureEnabled } from "../../../lib/env.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import { createInMemoryModelRequestDebugStore } from "./adapters/in-memory/in-memory-model-request-debug-store.js";
import { createNoopModelRequestDebugStore } from "./adapters/noop/noop-model-request-debug-store.js";
import type { ModelRequestDebugStore } from "./ports/model-request-debug-store.js";

let startupLogged = false;

export function isModelRequestDebugCaptureEnabled(): boolean {
  return modelRequestDebugCaptureEnabled;
}

export function createModelRequestDebugStoreFromEnv(eventSink?: EventSink): ModelRequestDebugStore {
  if (!modelRequestDebugCaptureEnabled) {
    return createNoopModelRequestDebugStore();
  }

  if (!startupLogged) {
    if (eventSink) {
      emitEvent(eventSink, {
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
