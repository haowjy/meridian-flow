/**
 * A provider's failure answer: the gateway's evidence record, what dev capture keeps,
 * and its body-less slice on a failed reply (`turn.metadata.providerError`). Shared by
 * server, app, and dev CLI.
 */

import { z } from "zod";
import type { JsonValue } from "./index.js";

/** Bound on a stored provider body; error bodies are small unless a proxy returns HTML. */
const PROVIDER_ERROR_BODY_LIMIT = 4_096;

/**
 * The provider's own failure response, kept as debug evidence. `message` is the
 * provider's human text; `body` is the response body as received, capped at 4,096
 * characters. Never enters event payloads or model context.
 */
export type ProviderErrorResponse = {
  /** HTTP status; null when the provider reported the failure inside the stream. */
  status: number | null;
  message: string;
  body: string;
};

/** The one constructor: owns the body cap. */
export function providerErrorResponse(input: {
  status: number | null;
  message: string;
  rawBody: string;
}): ProviderErrorResponse {
  return {
    status: input.status,
    message: input.message,
    body: input.rawBody.slice(0, PROVIDER_ERROR_BODY_LIMIT),
  };
}

/**
 * The provider's answer on a failed reply: owner-scoped debug evidence for
 * `./mf thread view`. The message never enters event payloads or model context,
 * and the app never shows it.
 */
export type ReplyProviderError = Omit<ProviderErrorResponse, "body"> & { gatewayCallId: string };

const ReplyProviderErrorCodec: z.ZodType<ReplyProviderError> = z.object({
  status: z.number().int().nullable(),
  message: z.string(),
  gatewayCallId: z.string().min(1),
});

/** The provider's answer recorded on a failed reply's metadata, if it gave one. */
export function replyProviderError(
  metadata: JsonValue | null | undefined,
): ReplyProviderError | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return ReplyProviderErrorCodec.safeParse(metadata.providerError).data ?? null;
}

/**
 * The provider turned the request down and the gateway judged a retry futile:
 * the failed reply's `metadata.retryable` is false and the provider answered.
 */
export function isProviderDeclined(metadata: JsonValue | null | undefined): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return metadata.retryable === false && replyProviderError(metadata) !== null;
}
