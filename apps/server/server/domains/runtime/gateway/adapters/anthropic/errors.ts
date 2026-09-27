/** Anthropic error mapping: maps Anthropic SDK errors to canonical gateway ErrorCode + retryable flags. Keeps provider error shapes out of the gateway core. */
import Anthropic from "@anthropic-ai/sdk";
import type { ErrorCode } from "../../domain/index.js";
import { withProviderRetryMetadata } from "../provider-error-metadata.js";

export function mapAnthropicError(err: unknown): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
} {
  const message = err instanceof Error ? err.message : String(err);
  const mapped: { code: ErrorCode; message: string; retryable: boolean } = (() => {
    if (err instanceof Anthropic.AuthenticationError) {
      return { code: "auth_error" as const, message, retryable: false };
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      return { code: "auth_error" as const, message, retryable: false };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { code: "rate_limited" as const, message, retryable: true };
    }
    if (err instanceof Anthropic.InternalServerError) {
      return { code: "server_error" as const, message, retryable: true };
    }

    if (err instanceof Anthropic.BadRequestError) {
      const lower = message.toLowerCase();
      if (
        /context[_ ](?:length|window)|prompt is too long|maximum context length|too many (?:input )?tokens|input.*exceeds.*token/.test(
          lower,
        )
      ) {
        return { code: "context_overflow" as const, message, retryable: false };
      }
      if (lower.includes("content") && (lower.includes("filter") || lower.includes("block"))) {
        return { code: "content_filtered" as const, message, retryable: false };
      }
      return { code: "invalid_request" as const, message, retryable: false };
    }

    if (err instanceof Anthropic.APIError) {
      const status = err.status;
      if (status !== undefined && status >= 500) {
        return { code: "server_error" as const, message, retryable: true };
      }
    }

    const code =
      err instanceof TypeError || message.includes("fetch") ? "network_error" : "provider_error";
    const retryable = code === "network_error" || code === "provider_error";
    return { code, message, retryable };
  })();

  return withProviderRetryMetadata(err, mapped);
}
