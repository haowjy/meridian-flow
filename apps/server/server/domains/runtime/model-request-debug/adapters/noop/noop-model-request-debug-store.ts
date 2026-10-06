/**
 * No-op ModelRequestDebugStore: satisfies the port when capture is disabled
 * (production default). Routes return 404 when captureEnabled is false.
 */
import type {
  ModelRequestDebugRecord,
  ModelRequestDebugRetention,
} from "@meridian/contracts/threads";
import type { ModelRequestDebugCaptureInput } from "../../build-record.js";
import type { ModelRequestDebugStore } from "../../ports/model-request-debug-store.js";

export class NoopModelRequestDebugStore implements ModelRequestDebugStore {
  readonly captureEnabled = false;

  capture(_input: ModelRequestDebugCaptureInput): void {
    // intentionally empty
  }

  listByTurn(_threadId: string, _turnId: string): ModelRequestDebugRecord[] {
    return [];
  }

  listByThread(_threadId: string): ModelRequestDebugRecord[] {
    return [];
  }

  retention(): ModelRequestDebugRetention {
    return { retainedRecords: 0, retainedBytes: 0, droppedRecords: 0, droppedBytes: 0 };
  }
}

export function createNoopModelRequestDebugStore(): NoopModelRequestDebugStore {
  return new NoopModelRequestDebugStore();
}
