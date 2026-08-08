import { encodeWsServerMessage, WS_CLOSE } from "@meridian/contracts/protocol";
import { defineWebSocketHandler } from "nitro";
import { getProcessEventSink } from "../../../lib/observability.js";
import {
  createThreadWebSocketSession,
  type WsAuthenticatedContext,
  type WsPeer,
} from "../../../lib/ws-thread-handler.js";
import { resolveWsUpgradeAuth, type WsDeferredClose } from "../../../lib/ws-upgrade-auth.js";

const PING_INTERVAL_MS = 30_000;
const sessions = new WeakMap<WsPeer, ReturnType<typeof createThreadWebSocketSession>>();
const pingIntervals = new WeakMap<WsPeer, ReturnType<typeof setInterval>>();

type ThreadWsRouteContext =
  | (WsAuthenticatedContext & { kind: "authenticated" })
  | { kind: "deferred-close"; close: WsDeferredClose };

type ThreadWsRoutePeer = Omit<WsPeer, "context"> & {
  context?: ThreadWsRouteContext;
};

function clearPing(peer: WsPeer): void {
  const interval = pingIntervals.get(peer);
  if (!interval) return;
  clearInterval(interval);
  pingIntervals.delete(peer);
}

function disposePeer(peer: WsPeer, event: "close" | "error" = "close"): void {
  clearPing(peer);
  const session = sessions.get(peer);
  if (event === "error") session?.onError();
  else session?.onClose();
  sessions.delete(peer);
}

export default defineWebSocketHandler(() => ({
  async upgrade(request) {
    const auth = await resolveWsUpgradeAuth(request, {
      logPrefix: "ws-thread-route",
      eventSink: getProcessEventSink(),
    });
    if (auth.kind === "deferred-close") {
      return {
        context: { kind: "deferred-close", close: auth.close } satisfies ThreadWsRouteContext,
      };
    }
    return {
      context: Object.freeze({
        kind: "authenticated",
        app: auth.app,
        userId: auth.userId,
        traceId: auth.traceId,
      } satisfies ThreadWsRouteContext),
    };
  },

  open(peer) {
    const wsPeer = peer as unknown as ThreadWsRoutePeer;
    const context = wsPeer.context;
    if (context?.kind === "deferred-close") {
      wsPeer.send(
        encodeWsServerMessage({
          type: "error",
          kind: "error",
          error: {
            code: context.close.reason,
            message:
              context.close.reason === WS_CLOSE.AUTH_FAILED.reason
                ? "Authentication failed"
                : "Internal server error",
            retryable: false,
            source: "system",
          },
        }),
      );
      wsPeer.close(context.close.code, context.close.reason);
      return;
    }

    const authenticatedPeer = wsPeer as unknown as WsPeer;
    const session = createThreadWebSocketSession(authenticatedPeer);
    sessions.set(authenticatedPeer, session);
    if (!session.open()) {
      disposePeer(authenticatedPeer);
      return;
    }
    pingIntervals.set(
      authenticatedPeer,
      setInterval(() => {
        try {
          wsPeer.send(encodeWsServerMessage({ type: "ping", ts: Date.now() }));
        } catch {
          disposePeer(authenticatedPeer, "error");
        }
      }, PING_INTERVAL_MS),
    );
  },

  message(peer, message) {
    const session = sessions.get(peer as unknown as WsPeer);
    void session?.onMessage(message.text());
  },

  close(peer) {
    disposePeer(peer as unknown as WsPeer, "close");
  },

  error(peer) {
    disposePeer(peer as unknown as WsPeer, "error");
  },
}));
