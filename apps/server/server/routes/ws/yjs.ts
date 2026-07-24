/** Thin CrossWS transport shell for the Hocuspocus-backed Yjs gateway. */
import type { UserId } from "@meridian/contracts/runtime";
import { defineWebSocketHandler } from "nitro";
import type { AppServices } from "../../lib/app.js";
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
  | { kind: "authenticated"; app: AppServices; userId: UserId; gateway: YjsGateway }
  | { kind: "deferred-close"; close: WsDeferredClose };

type YjsRoutePeer = {
  request: Request;
  context?: YjsRouteContext;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  websocket?: { readyState?: number };
  _yjs?: YjsGatewayConnection;
};

let gateway: YjsGateway | null = null;

export function getYjsGateway(app: AppServices): YjsGateway {
  gateway ??= createYjsGateway(selectYjsGatewayServices(app));
  return gateway;
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
            gateway: getYjsGateway(auth.app),
          } satisfies YjsRouteContext,
        };
  },
  open(peer) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    if (wsPeer.context?.kind === "deferred-close") {
      wsPeer.close(wsPeer.context.close.code, wsPeer.context.close.reason);
      return;
    }
    if (wsPeer.context?.kind !== "authenticated") return;
    wsPeer._yjs = wsPeer.context.gateway.connect({
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
  message(peer, message) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    if (wsPeer.context?.kind !== "authenticated") return;
    wsPeer.context.gateway.message(wsPeer._yjs, message.uint8Array());
  },
  close(peer, event) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    if (wsPeer.context?.kind !== "authenticated") return;
    wsPeer.context.gateway.close(wsPeer._yjs, event);
    delete wsPeer._yjs;
  },
  error(peer) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    if (wsPeer.context?.kind !== "authenticated") return;
    wsPeer.context.gateway.error(wsPeer._yjs);
    delete wsPeer._yjs;
  },
});

export default yjsWebSocketHandler;
