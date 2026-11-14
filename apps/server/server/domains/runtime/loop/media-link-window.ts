/**
 * The window a signed media link is pinned to. A link that changes between requests changes the
 * prompt prefix, so every request in one window gets the same link; the window is the prompt
 * cache's lifetime, so the one miss when it rolls over costs no more than the cache expiring.
 */
import type { GenerateRequest } from "@meridian-flow/gateway";
import type { LinkWindow } from "../ports/media-resolver.js";

export function linkWindowAt(nowMs: number, lengthSeconds: number): LinkWindow {
  const lengthMs = lengthSeconds * 1000;
  return { startMs: Math.floor(nowMs / lengthMs) * lengthMs, lengthSeconds };
}

/**
 * How long past the end of its window a link must stay fetchable: request preparation, the
 * gateway's retries (3 attempts, each up to the 15-minute `DEFAULT_ATTEMPT_CEILING_MS`, with
 * backoff) and the provider's own fetch. Retries reuse the request they were built from, so a
 * request built at the very end of a window still needs its links at the end of this horizon.
 */
const LINK_RETRY_HORIZON_SECONDS = 3600;

/**
 * A link is signed as of its window's start, so every process signs the same one; it stays valid
 * through the window and the retry horizon after it.
 */
export function linkExpirySeconds(window: LinkWindow): number {
  return window.lengthSeconds + LINK_RETRY_HORIZON_SECONDS;
}

/** Whether any part of the request is media sent by link. */
export function requestCarriesMediaLink(request: Pick<GenerateRequest, "messages">): boolean {
  return request.messages.some((message) =>
    message.content.some(
      (part) =>
        (part.type === "media" && "url" in part.source) ||
        (part.type === "tool_result" &&
          part.content.some((inner) => inner.type === "media" && "url" in inner.source)),
    ),
  );
}
