/** OpenAI-compatible error mapping: maps Chat Completions SDK errors to canonical gateway ErrorCode + retryable flags. Keeps provider error shapes out of the gateway core. */
import type { ErrorCode } from "../../domain/index.js";
import { withProviderRetryMetadata } from "../provider-error-metadata.js";

export function mapOpenAIError(err: unknown): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
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

  const mapped: { code: ErrorCode; message: string; retryable: boolean } = (() => {
    if (status === 401 || status === 403) {
      return { code: "auth_error" as const, message, retryable: false };
    }
    if (status === 429) {
      return { code: "rate_limited" as const, message, retryable: true };
    }
    if (status === 400) {
      const lower = message.toLowerCase();
      if (
        /context[_ ](?:length|window)|prompt is too long|maximum context length|too many (?:input )?tokens|input.*exceeds.*token/.test(
          lower,
        )
      ) {
        return { code: "context_overflow" as const, message, retryable: false };
      }
      if (lower.includes("content") && lower.includes("filter")) {
        return { code: "content_filtered" as const, message, retryable: false };
      }
      return { code: "invalid_request" as const, message, retryable: false };
    }
    if (status !== undefined && status >= 500) {
      return { code: "server_error" as const, message, retryable: true };
    }

    const code =
      err instanceof TypeError || message.includes("fetch") ? "network_error" : "provider_error";
    const retryable = code === "network_error" || code === "provider_error";
    return { code, message, retryable };
  })();

  return withProviderRetryMetadata(err, mapped);
}
