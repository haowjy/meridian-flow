/** Catch-all route: 404s unmatched requests and rejects stray WebSocket upgrades so unknown paths fail cleanly. */
import { createError, defineWebSocketHandler, getRequestHeader } from "nitro/h3";

const isWebSocketUpgrade = (upgradeHeader: string | undefined) =>
  upgradeHeader?.split(",").some((part) => part.trim().toLowerCase() === "websocket") ?? false;

export default defineWebSocketHandler((event) => {
  if (!isWebSocketUpgrade(getRequestHeader(event, "upgrade"))) {
    throw createError({
      statusCode: 404,
      statusMessage: `Cannot find any route matching [${event.req.method}] ${event.req.url}`,
    });
  }

  return {
    open(peer) {
      peer.close(1008, "WebSocket endpoint not found");
    },
  };
});
