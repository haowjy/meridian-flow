import type { JsonObject, JsonValue } from "../threads/index.js";

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
    };

export interface CheckpointRequest {
  checkpointId: string;
  prompt: string;
  artifacts: ArtifactRef[];
  answerSchema: JsonSchema;
  recommended?: JsonValue | null;
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

export function meridianError(
  input: Omit<MeridianError, "source"> & { source?: MeridianErrorSource },
): MeridianError {
  return {
    ...input,
    source: input.source ?? "system",
  };
}

export function isMeridianError(value: unknown): value is MeridianError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.retryable === "boolean" &&
    typeof record.source === "string"
  );
}

export function meridianErrorToJson(error: MeridianError): JsonObject {
  return JSON.parse(JSON.stringify(error)) as JsonObject;
}

export function wsErrorInterruptPayload(error: MeridianError): ErrorInterrupt {
  return errorInterrupt(error);
}

export function httpErrorInterruptBody(error: MeridianError): JsonObject {
  return {
    kind: "error",
    error: meridianErrorToJson(error),
  };
}
