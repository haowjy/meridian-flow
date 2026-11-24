import type { GenerateRequest } from "@meridian-flow/runtime/gateway";
import type { LinkWindow } from "../ports/media-resolver.js";

export function linkWindowAt(nowMs: number, lengthSeconds: number): LinkWindow {
  const lengthMs = lengthSeconds * 1000;
  return { startMs: Math.floor(nowMs / lengthMs) * lengthMs, lengthSeconds };
}

const LINK_RETRY_HORIZON_SECONDS = 3600;

export function linkExpirySeconds(window: LinkWindow): number {
  return window.lengthSeconds + LINK_RETRY_HORIZON_SECONDS;
}

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
