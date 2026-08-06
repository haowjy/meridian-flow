/**
 * ModelRequestDebugStore port: fire-and-forget capture of orchestrator model
 * requests for dev inspection. Not journal-backed — bounded in-memory only.
 */
import type {
  ModelRequestDebugRecord,
  ModelRequestDebugRetention,
} from "@meridian/contracts/threads";
import type { ModelRequestDebugCaptureInput } from "../build-record.js";

export interface ModelRequestDebugStore {
  /** False for the noop adapter — routes treat capture as unavailable (404). */
  readonly captureEnabled: boolean;
  capture(input: ModelRequestDebugCaptureInput): void;
  listByTurn(threadId: string, turnId: string): ModelRequestDebugRecord[];
  listByThread(threadId: string): ModelRequestDebugRecord[];
  retention(): ModelRequestDebugRetention;
}
