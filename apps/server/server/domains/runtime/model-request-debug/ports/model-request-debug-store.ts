// @ts-nocheck
/**
 * ModelRequestDebugStore port: fire-and-forget capture of orchestrator model
 * requests for dev inspection. Not journal-backed — bounded in-memory only.
 */
import type { ModelRequestDebugRecord } from "@meridian/contracts/threads";

export interface ModelRequestDebugStore {
  /** False for the noop adapter — routes treat capture as unavailable (404). */
  readonly captureEnabled: boolean;
  record(record: ModelRequestDebugRecord): void;
  listByTurn(threadId: string, turnId: string): ModelRequestDebugRecord[];
  listByThread(threadId: string): ModelRequestDebugRecord[];
}
