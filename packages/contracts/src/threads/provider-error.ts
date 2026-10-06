/**
 * A provider's failure answer: what the gateway reads off a failed call and what a
 * failed reply keeps as `turn.metadata.providerError`. Shared by server, app, and dev CLI.
 */

import { z } from "zod";
import type { JsonValue } from "./index.js";

/**
 * The provider's own status and message, kept as owner-scoped debug evidence for
 * `./mf thread view`. Never enters event payloads or model context, and the app
 * never shows the message.
 */
export type ProviderErrorResponse = {
  /** HTTP status; null when the provider reported the failure inside the stream. */
  status: number | null;
  message: string;
};

const ProviderErrorResponseCodec: z.ZodType<ProviderErrorResponse> = z.object({
  status: z.number().int().nullable(),
  message: z.string(),
});

/** The provider's answer recorded on a failed reply's metadata, if it gave one. */
export function replyProviderError(
  metadata: JsonValue | null | undefined,
): ProviderErrorResponse | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return ProviderErrorResponseCodec.safeParse(metadata.providerError).data ?? null;
}

/**
 * The provider turned the request down and the gateway judged a retry futile:
 * the failed reply's `metadata.retryable` is false and the provider answered.
 */
export function isProviderDeclined(metadata: JsonValue | null | undefined): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return metadata.retryable === false && replyProviderError(metadata) !== null;
}
