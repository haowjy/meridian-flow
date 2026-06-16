/**
 * No-op ModelRequestDebugStore: satisfies the port when capture is disabled
 * (production default). Routes return 404 when captureEnabled is false.
 */
import type { ModelRequestDebugRecord } from "@meridian/contracts/threads";

import type { ModelRequestDebugStore } from "../../ports/model-request-debug-store.js";

export class NoopModelRequestDebugStore implements ModelRequestDebugStore {
  readonly captureEnabled = false;

  record(_record: ModelRequestDebugRecord): void {
    // intentionally empty
  }

  listByTurn(_threadId: string, _turnId: string): ModelRequestDebugRecord[] {
    return [];
  }

  listByThread(_threadId: string): ModelRequestDebugRecord[] {
    return [];
  }
}

export function createNoopModelRequestDebugStore(): NoopModelRequestDebugStore {
  return new NoopModelRequestDebugStore();
}
