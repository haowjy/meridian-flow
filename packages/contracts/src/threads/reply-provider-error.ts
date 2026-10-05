/** The provider's answer on a failed reply (`turn.metadata.providerError`), shared by server, app, and dev CLI. */

import { z } from "zod";
import type { JsonValue } from "./index.js";

/**
 * Owner-scoped debug evidence for `./mf thread view`. The message never enters
 * event payloads or model context, and the app never shows it.
 */
export const ReplyProviderErrorCodec = z.object({
  status: z.number().int().nullable(),
  message: z.string(),
  gatewayCallId: z.string().min(1),
});
export type ReplyProviderError = z.infer<typeof ReplyProviderErrorCodec>;

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
export function isProviderRefusal(metadata: JsonValue | null | undefined): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return metadata.retryable === false && replyProviderError(metadata) !== null;
}
