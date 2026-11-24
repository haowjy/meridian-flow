import type {
  ModelRequestDebugRecord,
  ModelRequestDebugRetention,
} from "@meridian/contracts/threads";
import type { ModelRequestDebugCaptureInput } from "../build-record.js";

export interface ModelRequestDebugStore {
  readonly captureEnabled: boolean;
  capture(input: ModelRequestDebugCaptureInput): void;
  listByTurn(threadId: string, turnId: string): ModelRequestDebugRecord[];
  listByThread(threadId: string): ModelRequestDebugRecord[];
  retention(): ModelRequestDebugRetention;
}
