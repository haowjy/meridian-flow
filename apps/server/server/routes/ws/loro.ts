/** Thin CrossWS transport shell for the Loro room server (`lib/loro-ws-handler.ts`). */
import { defineWebSocketHandler } from "nitro";
import { runWithEventCorrelation } from "../../domains/observability/index.js";
import type { AppServices } from "../../lib/app.js";
import { createTreeRooms } from "../../lib/loro-tree-rooms.js";
import {
  createLoroGateway,
  type LoroGateway,
  type LoroGatewayConnection,
  type LoroGatewayServices,
} from "../../lib/loro-ws-handler.js";
import { getProcessEventSink } from "../../lib/observability.js";
import {
  deferWsClose,
  resolveWsUpgradeAuth,
  type WsAuthenticatedUpgrade,
  type WsDeferredClose,
} from "../../lib/ws-upgrade-auth.js";

type LoroRouteContext =
  | (WsAuthenticatedUpgrade & { gateway: LoroGateway })
  | { kind: "deferred-close"; close: WsDeferredClose };

type LoroRoutePeer = {
  context?: LoroRouteContext;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  _loro?: LoroGatewayConnection;
};

let gateway: LoroGateway | null = null;

export function getLoroGateway(app: AppServices): LoroGateway {
  gateway ??= createLoroGateway(selectLoroGatewayServices(app));
  return gateway;
}

function selectLoroGatewayServices(app: AppServices): LoroGatewayServices {
  const sync = app.documentSync;
  return {
    fileAccess: app.fileAccess,
    fileAccessChanges: app.fileAccessChanges,
    rooms: sync.rooms,
    trees: createTreeRooms({ treeLists: app.treeLists, eventSink: app.eventSink }),
    documents: {
      draftsHolding: sync.draftsHolding,
      roomRemoval: sync.roomRemoval,
      schemaVersion: sync.documentSchemaVersion,
      onRoomsEnded: sync.onRoomsEnded,
    },
    eventSink: app.eventSink,
    presence: app.presence,
  };
}

const traced = (
  peer: LoroRoutePeer,
  run: (context: WsAuthenticatedUpgrade & { gateway: LoroGateway }) => void,
) => {
  const context = peer.context;
  if (context?.kind !== "authenticated") return;
  runWithEventCorrelation({ traceId: context.traceId }, () => run(context));
};

export default defineWebSocketHandler({
  async upgrade(request) {
    const auth = await resolveWsUpgradeAuth(request, {
      logPrefix: "ws-loro-route",
      eventSink: getProcessEventSink(),
    });
    if (auth.kind === "deferred-close")
      return { context: deferWsClose(auth.close) satisfies LoroRouteContext };
    return {
      context: Object.freeze({
        ...auth,
        gateway: getLoroGateway(auth.app),
      }) satisfies LoroRouteContext,
    };
  },
  open(peer) {
    const wsPeer = peer as unknown as LoroRoutePeer;
    if (wsPeer.context?.kind === "deferred-close") {
      wsPeer.close(wsPeer.context.close.code, wsPeer.context.close.reason);
      return;
    }
    traced(wsPeer, (context) => {
      wsPeer._loro = context.gateway.connect({
        userId: context.userId,
        traceId: context.traceId,
        send: (data) => wsPeer.send(data),
        close: (code, reason) => wsPeer.close(code, reason),
      });
    });
  },
  message(peer, message) {
    const wsPeer = peer as unknown as LoroRoutePeer;
    traced(wsPeer, (context) => context.gateway.message(wsPeer._loro, message.uint8Array()));
  },
  close(peer) {
    const wsPeer = peer as unknown as LoroRoutePeer;
    traced(wsPeer, (context) => context.gateway.close(wsPeer._loro));
    delete wsPeer._loro;
  },
  error(peer) {
    const wsPeer = peer as unknown as LoroRoutePeer;
    traced(wsPeer, (context) => context.gateway.close(wsPeer._loro));
    delete wsPeer._loro;
  },
});
