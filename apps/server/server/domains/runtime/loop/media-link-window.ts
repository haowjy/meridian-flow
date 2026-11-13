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

/** Links signed as of the window's start expire two windows later, so none dies mid-window. */
export function linkExpirySeconds(window: LinkWindow): number {
  return window.lengthSeconds * 2;
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
