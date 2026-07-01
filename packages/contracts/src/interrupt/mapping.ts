/**
 * Purpose: Maps domain and transport failures to the canonical MeridianError envelope and shared HTTP/WS serialization.
 * Key decisions: one JSON body shape for the error interrupt arm; WS adds only routing fields (`type`, `threadId`).
 */
import type { JsonObject, JsonValue } from "../threads/index.js";
import type { ErrorInterrupt, MeridianError, MeridianErrorSource } from "./index.js";

const MERIDIAN_ERROR_SOURCES = new Set<MeridianErrorSource>([
  "gateway",
  "tool",
  "child-agent",
  "system",
]);

/** Type guard for a fully-shaped MeridianError (all required fields, correct types). */
export function isMeridianError(value: unknown): value is MeridianError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.retryable === "boolean" &&
    typeof record.source === "string" &&
    MERIDIAN_ERROR_SOURCES.has(record.source as MeridianErrorSource)
  );
}

/** Serializes a MeridianError to JsonObject for journal events and tool result envelopes. */
export function meridianErrorToJson(error: MeridianError): JsonObject {
  return JSON.parse(JSON.stringify(error)) as JsonObject;
}

export type GatewayErrorCode =
  | "network_error"
  | "rate_limited"
  | "server_error"
  | "auth_error"
  | "malformed_response"
  | "invalid_request"
  | "content_filtered"
  | "context_overflow"
  | "provider_error";

const RETRYABLE_GATEWAY_CODES = new Set<GatewayErrorCode>([
  "network_error",
  "rate_limited",
  "server_error",
  "provider_error",
]);

export function meridianError(input: {
  code: string;
  message: string;
  source: MeridianErrorSource;
  retryable?: boolean;
  details?: JsonValue;
}): MeridianError {
  return {
    code: input.code,
    message: input.message,
    source: input.source,
    retryable: input.retryable ?? false,
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
}

export function meridianErrorFromGateway(
  code: GatewayErrorCode,
  message: string,
  retryable = RETRYABLE_GATEWAY_CODES.has(code),
): MeridianError {
  return meridianError({
    code,
    message,
    source: "gateway",
    retryable,
  });
}

export function meridianErrorFromTool(
  message: string,
  details?: JsonValue,
  code = "tool_error",
): MeridianError {
  return meridianError({
    code,
    message,
    source: "tool",
    retryable: false,
    details,
  });
}

export function meridianErrorFromStructuredToolOutput(output: JsonValue): MeridianError {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") {
      return meridianError({
        code: record.code,
        message: record.message,
        source: "tool",
        retryable: record.retryable === true,
        details:
          record.details !== undefined ? (record.details as JsonValue) : (output as JsonValue),
      });
    }
    if (typeof record.message === "string") {
      return meridianErrorFromTool(record.message, output);
    }
  }
  if (typeof output === "string") {
    return meridianErrorFromTool(output);
  }
  return meridianErrorFromTool(JSON.stringify(output), output);
}

export function meridianErrorFromSystem(
  code: string,
  message: string,
  retryable = false,
): MeridianError {
  return meridianError({ code, message, source: "system", retryable });
}

/** Shared interrupt error payload serialized identically on HTTP bodies and WS error frames. */
export function sharedErrorInterrupt(error: MeridianError): ErrorInterrupt {
  return JSON.parse(JSON.stringify({ kind: "error", error })) as ErrorInterrupt;
}

export function httpErrorInterruptBody(error: MeridianError): ErrorInterrupt {
  return sharedErrorInterrupt(error);
}

export function wsErrorInterruptPayload(
  error: MeridianError,
  threadId?: string,
): ErrorInterrupt & { type: "error"; threadId?: string } {
  const payload = sharedErrorInterrupt(error);
  return {
    type: "error",
    ...payload,
    ...(threadId ? { threadId } : {}),
  };
}

const WS_BOUNDARY_CODES: Record<string, Pick<MeridianError, "code" | "retryable">> = {
  auth_failed: { code: "auth_failed", retryable: false },
  scope_mismatch: { code: "scope_mismatch", retryable: false },
  not_subscribed: { code: "not_subscribed", retryable: false },
  thread_not_found: { code: "not_found", retryable: false },
  forbidden: { code: "forbidden", retryable: false },
  already_active: { code: "already_active", retryable: false },
  rate_limited: { code: "rate_limited", retryable: true },
  bad_request: { code: "bad_request", retryable: false },
  interrupt_not_pending: { code: "interrupt_not_pending", retryable: false },
  interrupt_correlation_mismatch: {
    code: "interrupt_correlation_mismatch",
    retryable: false,
  },
  internal: { code: "internal", retryable: false },
};

export function meridianErrorFromWsBoundary(code: string, message: string): MeridianError {
  const mapped = WS_BOUNDARY_CODES[code];
  return meridianError({
    code: mapped?.code ?? code,
    message,
    source: "system",
    retryable: mapped?.retryable ?? false,
  });
}

export function meridianErrorFromHttpStatus(statusCode: number, message: string): MeridianError {
  if (statusCode === 401) {
    return meridianErrorFromSystem("auth_failed", message);
  }
  if (statusCode === 403) {
    return meridianErrorFromSystem("forbidden", message);
  }
  if (statusCode === 404) {
    return meridianErrorFromSystem("not_found", message);
  }
  if (statusCode === 409) {
    return meridianErrorFromSystem("conflict", message);
  }
  if (statusCode === 429) {
    return meridianErrorFromSystem("rate_limited", message, true);
  }
  if (statusCode >= 500) {
    return meridianErrorFromSystem("internal", message);
  }
  return meridianErrorFromSystem("bad_request", message);
}
