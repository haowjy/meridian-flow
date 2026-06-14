/**
 * Purpose: Defines the canonical interrupt envelope (error + checkpoint) shared across HTTP, WS, and runtime surfaces.
 * Key decisions: JSON-natural shapes per execution-model §6.1; ArtifactRef includes a probe-gated liveView arm only (no viewer implementation).
 */
import type { JsonObject, JsonValue } from "../threads/index.js";

/** JSON Schema object describing the typed shape of a checkpoint reply. */
export type JsonSchema = JsonObject;

export type MeridianErrorSource = "gateway" | "tool" | "child-agent" | "system";

export type MeridianError = {
  code: string;
  message: string;
  retryable: boolean;
  source: MeridianErrorSource;
  details?: JsonValue;
};

export type ArtifactRef =
  | {
      type: "image";
      url: string;
      label?: string;
      mimeType?: string;
    }
  | {
      type: "object";
      uri: string;
      label?: string;
      mimeType?: string;
    }
  | {
      // DEFERRED(live-viewer): build the iframe overlay iff the live-preview
      // probe is green.
      type: "liveView";
      url: string;
      expiresAt?: string;
    };

export interface CheckpointRequest {
  checkpointId: string;
  prompt: string;
  artifacts: ArtifactRef[];
  answerSchema: JsonSchema;
  /** Safe default applied when checkpoint auto-resume fires on timeout. */
  recommended?: JsonValue | null;
  /** When true, timeout must not auto-resolve even if recommended is set. */
  requiresHuman?: boolean;
}

export type ErrorInterrupt = { kind: "error"; error: MeridianError };
export type CheckpointInterrupt = { kind: "checkpoint"; checkpoint: CheckpointRequest };
export type Interrupt = ErrorInterrupt | CheckpointInterrupt;

export function errorInterrupt(error: MeridianError): ErrorInterrupt {
  return { kind: "error", error };
}

export function checkpointInterrupt(checkpoint: CheckpointRequest): CheckpointInterrupt {
  return { kind: "checkpoint", checkpoint };
}

export * from "./builders.js";
export * from "./mapping.js";
