import type { JsonValue, ProviderErrorResponse } from "@meridian-flow/runtime/gateway/shapes";
import { z } from "zod";

const ProviderErrorResponseCodec: z.ZodType<ProviderErrorResponse> = z.object({
  status: z.number().int().nullable(),
  message: z.string(),
});

export function replyProviderError(
  metadata: JsonValue | null | undefined,
): ProviderErrorResponse | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return ProviderErrorResponseCodec.safeParse(metadata.providerError).data ?? null;
}

export function isProviderDeclined(metadata: JsonValue | null | undefined): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return metadata.retryable === false && replyProviderError(metadata) !== null;
}
