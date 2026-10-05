/**
 * ModelRequestDebugStore port: fire-and-forget capture of reply and summary
 * model requests, and their provider failure responses, for dev inspection.
 * Not journal-backed — bounded in-memory only.
 */
import type {
  ModelRequestDebugRecord,
  ModelRequestDebugRetention,
  ProviderErrorResponse,
} from "@meridian/contracts/threads";
import type { ModelRequestDebugCaptureInput } from "../build-record.js";

export interface ModelRequestDebugStore {
  /** False for the noop adapter — routes treat capture as unavailable (404). */
  readonly captureEnabled: boolean;
  capture(input: ModelRequestDebugCaptureInput): void;
  /** Attach the provider's failure response to the captured call; a no-op once it was evicted. */
  recordProviderError(gatewayCallId: string, error: ProviderErrorResponse): void;
  listByTurn(threadId: string, turnId: string): ModelRequestDebugRecord[];
  listByThread(threadId: string): ModelRequestDebugRecord[];
  retention(): ModelRequestDebugRetention;
}
