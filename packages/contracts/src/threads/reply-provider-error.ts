/** The provider's answer on a failed reply (`turn.metadata.providerError`), shared by server, app, and dev CLI. */

import { z } from "zod";
import type { JsonValue } from "./index.js";

/**
 * Owner-scoped debug evidence for `./mf thread view`, plus the gateway's retry
 * decision. The message never enters event payloads or model context, and the
 * app never shows it.
 */
export const ReplyProviderErrorCodec = z.object({
  status: z.number().int().nullable(),
  message: z.string(),
  gatewayCallId: z.string().min(1),
  /** The gateway's verdict on this answer: `false` means sending it again fails the same way. */
  retryable: z.boolean(),
});
export type ReplyProviderError = z.infer<typeof ReplyProviderErrorCodec>;

/** The provider's answer recorded on a failed reply's metadata, if it gave one. */
export function replyProviderError(
  metadata: JsonValue | null | undefined,
): ReplyProviderError | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return ReplyProviderErrorCodec.safeParse(metadata.providerError).data ?? null;
}

/** The provider turned the request down and the gateway judged a retry futile. */
export function isProviderRefusal(metadata: JsonValue | null | undefined): boolean {
  return replyProviderError(metadata)?.retryable === false;
}
