// @ts-nocheck
/** OpenAI Responses error mapping: maps OpenAI SDK errors to canonical gateway ErrorCode + retryable flags. Keeps provider error shapes out of the gateway core. */
import type { ErrorCode } from "../../domain/index.js";

export function mapOpenAIResponsesError(err: unknown): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
} {
  const status =
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : undefined;

  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);

  if (status === 401 || status === 403) {
    return { code: "auth_error", message, retryable: false };
  }
  if (status === 429) {
    return { code: "rate_limited", message, retryable: true };
  }
  if (status === 400) {
    const lower = message.toLowerCase();
    if (lower.includes("context") || lower.includes("token")) {
      return { code: "context_overflow", message, retryable: false };
    }
    if (lower.includes("content") && lower.includes("filter")) {
      return { code: "content_filtered", message, retryable: false };
    }
    return { code: "invalid_request", message, retryable: false };
  }
  if (status !== undefined && status >= 500) {
    return { code: "server_error", message, retryable: true };
  }

  const code =
    err instanceof TypeError || message.includes("fetch") ? "network_error" : "provider_error";
  const retryable = code === "network_error" || code === "provider_error";
  return { code, message, retryable };
}
