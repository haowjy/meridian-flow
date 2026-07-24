/** Thin CrossWS transport shell for the Hocuspocus-backed Yjs gateway. */
import type { UserId } from "@meridian/contracts/runtime";
import { defineWebSocketHandler } from "nitro";
import type { AppServices } from "../../lib/app.js";
import { getApp } from "../../lib/app.js";
import {
  deferWsClose,
  resolveWsUpgradeAuth,
  type WsDeferredClose,
} from "../../lib/ws-upgrade-auth.js";
import {
  createYjsGateway,
  selectYjsGatewayServices,
  type YjsGateway,
  type YjsGatewayConnection,
} from "../../lib/yjs-ws-handler.js";

type YjsRouteContext =
  | { kind: "authenticated"; app: AppServices; userId: UserId }
  | { kind: "deferred-close"; close: WsDeferredClose };

type YjsRoutePeer = {
  request: Request;
  context?: YjsRouteContext;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  websocket?: { readyState?: number };
  _yjs?: YjsGatewayConnection;
};

let gatewayPromise: Promise<YjsGateway> | null = null;

export function getYjsGateway(): Promise<YjsGateway> {
  gatewayPromise ??= getApp().then((app) => createYjsGateway(selectYjsGatewayServices(app)));
  return gatewayPromise;
}

export const yjsWebSocketHandler = defineWebSocketHandler({
  async upgrade(request) {
    const auth = await resolveWsUpgradeAuth(request, { logPrefix: "ws-yjs-route" });
    return auth.kind === "deferred-close"
      ? { context: deferWsClose(auth.close) satisfies YjsRouteContext }
      : {
          context: {
            kind: "authenticated",
            app: auth.app,
            userId: auth.userId,
          } satisfies YjsRouteContext,
        };
  },
  async open(peer) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    if (wsPeer.context?.kind === "deferred-close") {
      wsPeer.close(wsPeer.context.close.code, wsPeer.context.close.reason);
      return;
    }
    if (wsPeer.context?.kind !== "authenticated") return;
    wsPeer._yjs = (await getYjsGateway()).connect({
      request: wsPeer.request,
      userId: wsPeer.context.userId,
      close: (code, reason) => wsPeer.close(code, reason),
      socket: {
        send: (data) =>
          wsPeer.send(typeof data === "string" ? data : new Uint8Array(data as ArrayBufferLike)),
        close: (code, reason) => wsPeer.close(code, reason),
        get readyState() {
          return wsPeer.websocket?.readyState ?? 1;
        },
      },
    });
  },
  async message(peer, message) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    (await getYjsGateway()).message(wsPeer._yjs, message.uint8Array());
  },
  async close(peer, event) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    (await getYjsGateway()).close(wsPeer._yjs, event);
    delete wsPeer._yjs;
  },
  async error(peer) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    (await getYjsGateway()).error(wsPeer._yjs);
    delete wsPeer._yjs;
  },
});

export default yjsWebSocketHandler;
