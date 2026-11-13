/**
 * A provider's failure answer: what the gateway reads off a failed call and what a
 * failed reply keeps as `turn.metadata.providerError`. Shared by server, app, and dev CLI.
 */

import type { JsonValue, ProviderErrorResponse } from "@meridian-flow/gateway/shapes";
import { z } from "zod";

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
 * The provider turned the request down and the gateway ruled out an automatic
 * retry: `metadata.retryable` is false and the provider answered. A writer
 * may still retry once the cause is fixed.
 */
export function isProviderDeclined(metadata: JsonValue | null | undefined): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return metadata.retryable === false && replyProviderError(metadata) !== null;
}
