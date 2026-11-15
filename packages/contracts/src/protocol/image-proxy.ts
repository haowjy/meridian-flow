/**
 * The image proxy: a remote image drawn from Flow's own origin once the writer has chosen to load it.
 * The address is the whole cache key, so a repeat load of one address is served from the browser's cache.
 */

/** Why the proxy refused, on the `IMAGE_PROXY_REASON_HEADER` of a non-2xx answer. */
export const IMAGE_PROXY_REASONS = [
  "too_large",
  "not_image",
  "not_allowed",
  "port",
  "unreachable",
  "timeout",
] as const;

export type ImageProxyReason = (typeof IMAGE_PROXY_REASONS)[number];

export const IMAGE_PROXY_REASON_HEADER = "x-image-proxy-reason";

/** The largest image the proxy passes on. */
export const IMAGE_PROXY_MAX_BYTES = 10 * 1024 * 1024;

export function apiImageProxyPath(address: string): string {
  return `/api/image-proxy?${new URLSearchParams({ url: address })}`;
}

export function imageProxyReason(value: string | null): ImageProxyReason | null {
  return IMAGE_PROXY_REASONS.find((reason) => reason === value) ?? null;
}
