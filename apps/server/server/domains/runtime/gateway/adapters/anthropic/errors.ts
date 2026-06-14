// @ts-nocheck
/** Anthropic error mapping: maps Anthropic SDK errors to canonical gateway ErrorCode + retryable flags. Keeps provider error shapes out of the gateway core. */
import Anthropic from "@anthropic-ai/sdk";
import type { ErrorCode } from "../../domain/index.js";

export function mapAnthropicError(err: unknown): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
} {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof Anthropic.AuthenticationError) {
    return { code: "auth_error", message, retryable: false };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { code: "auth_error", message, retryable: false };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { code: "rate_limited", message, retryable: true };
  }
  if (err instanceof Anthropic.InternalServerError) {
    return { code: "server_error", message, retryable: true };
  }

  if (err instanceof Anthropic.BadRequestError) {
    const lower = message.toLowerCase();
    if (lower.includes("context") || lower.includes("token") || lower.includes("too long")) {
      return { code: "context_overflow", message, retryable: false };
    }
    if (lower.includes("content") && (lower.includes("filter") || lower.includes("block"))) {
      return { code: "content_filtered", message, retryable: false };
    }
    return { code: "invalid_request", message, retryable: false };
  }

  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status !== undefined && status >= 500) {
      return { code: "server_error", message, retryable: true };
    }
    if (status === 529) {
      // Anthropic overloaded
      return { code: "server_error", message, retryable: true };
    }
  }

  const code =
    err instanceof TypeError || message.includes("fetch") ? "network_error" : "provider_error";
  const retryable = code === "network_error" || code === "provider_error";
  return { code, message, retryable };
}
