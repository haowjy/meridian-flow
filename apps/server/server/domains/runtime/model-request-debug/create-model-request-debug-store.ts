/**
 * Composition helper: pick in-memory capture vs noop from the typed env gate
 * (`modelRequestDebugCaptureEnabled` in `lib/env.ts`).
 */
import { modelRequestDebugCaptureEnabled } from "../../../lib/env.js";
import { createInMemoryModelRequestDebugStore } from "./adapters/in-memory/in-memory-model-request-debug-store.js";
import { createNoopModelRequestDebugStore } from "./adapters/noop/noop-model-request-debug-store.js";
import type { ModelRequestDebugStore } from "./ports/model-request-debug-store.js";

let startupLogged = false;

export function isModelRequestDebugCaptureEnabled(): boolean {
  return modelRequestDebugCaptureEnabled;
}

export function createModelRequestDebugStoreFromEnv(): ModelRequestDebugStore {
  if (!modelRequestDebugCaptureEnabled) {
    return createNoopModelRequestDebugStore();
  }

  if (!startupLogged) {
    console.log("[@meridian/server] model-request debug capture: enabled");
    startupLogged = true;
  }

  return createInMemoryModelRequestDebugStore();
}
