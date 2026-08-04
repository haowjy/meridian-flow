/** Thin CrossWS transport shell for the Hocuspocus-backed Yjs gateway. */
import type { UserId } from "@meridian/contracts/runtime";
import { selectCollabSchemaSubprotocol } from "@meridian/prosemirror-schema";
import { defineWebSocketHandler } from "nitro";
import { runWithEventCorrelation } from "../../domains/observability/index.js";
import type { AppServices } from "../../lib/app.js";
import { getProcessEventSink } from "../../lib/observability.js";
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
  | {
      kind: "authenticated";
      app: AppServices;
      userId: UserId;
      gateway: YjsGateway;
      traceId: string;
    }
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
    const auth = await resolveWsUpgradeAuth(request, {
      logPrefix: "ws-yjs-route",
      eventSink: getProcessEventSink(),
    });
    const selectedSubprotocol = selectCollabSchemaSubprotocol(
      request.headers.get("sec-websocket-protocol"),
    );
    const responseHeaders = selectedSubprotocol
      ? { headers: { "sec-websocket-protocol": selectedSubprotocol } }
      : {};
    return auth.kind === "deferred-close"
      ? { context: deferWsClose(auth.close) satisfies YjsRouteContext, ...responseHeaders }
      : {
          context: {
            kind: "authenticated",
            app: auth.app,
            userId: auth.userId,
            gateway: getYjsGateway(auth.app),
            traceId: auth.traceId,
          } satisfies YjsRouteContext,
          ...responseHeaders,
        };
  },
  open(peer) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    if (wsPeer.context?.kind === "deferred-close") {
      wsPeer.close(wsPeer.context.close.code, wsPeer.context.close.reason);
      return;
    }
    if (wsPeer.context?.kind !== "authenticated") return;
    wsPeer._yjs = runWithEventCorrelation({ traceId: wsPeer.context.traceId }, () =>
      wsPeer.context?.kind === "authenticated"
        ? wsPeer.context.gateway.connect({
            request: wsPeer.request,
            userId: wsPeer.context.userId,
            traceId: wsPeer.context.traceId,
            close: (code, reason) => wsPeer.close(code, reason),
            socket: {
              send: (data) =>
                wsPeer.send(
                  typeof data === "string" ? data : new Uint8Array(data as ArrayBufferLike),
                ),
              close: (code, reason) => wsPeer.close(code, reason),
              get readyState() {
                return wsPeer.websocket?.readyState ?? 1;
              },
            },
          })
        : undefined,
    );
  },
  message(peer, message) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    if (wsPeer.context?.kind !== "authenticated") return;
    runWithEventCorrelation({ traceId: wsPeer.context.traceId }, () =>
      wsPeer.context?.kind === "authenticated"
        ? wsPeer.context.gateway.message(wsPeer._yjs, message.uint8Array())
        : undefined,
    );
  },
  close(peer, event) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    if (wsPeer.context?.kind !== "authenticated") return;
    runWithEventCorrelation({ traceId: wsPeer.context.traceId }, () =>
      wsPeer.context?.kind === "authenticated"
        ? wsPeer.context.gateway.close(wsPeer._yjs, event)
        : undefined,
    );
    delete wsPeer._yjs;
  },
  error(peer) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    if (wsPeer.context?.kind !== "authenticated") return;
    runWithEventCorrelation({ traceId: wsPeer.context.traceId }, () =>
      wsPeer.context?.kind === "authenticated"
        ? wsPeer.context.gateway.error(wsPeer._yjs)
        : undefined,
    );
    delete wsPeer._yjs;
  },
});

export default yjsWebSocketHandler;
