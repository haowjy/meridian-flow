/** Throwaway Phase 0 Hocuspocus mount inside Nitro crossws; proves peer adapter/auth behavior only. */

import type { WebSocketLike } from "@hocuspocus/server";
import { Hocuspocus, OutgoingMessage } from "@hocuspocus/server";
import { defineWebSocketHandler } from "nitro";

type SpikeContext =
  | { kind: "authenticated"; userId: string; mode: string }
  | { kind: "deferred-close"; code: number; reason: string }
  | { kind: "protocol-close"; documentName: string; reason: string };

type SpikePeer = {
  request: Request;
  context?: SpikeContext;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  websocket?: { readyState?: number };
  _hpc?: ReturnType<Hocuspocus["handleConnection"]>;
};

const hocuspocus = new Hocuspocus({
  name: "meridian-phase0-spike",
  debounce: 50,
  maxDebounce: 100,
  async onConnect({ documentName, context }) {
    console.log(
      JSON.stringify({ event: "spike:onConnect", documentName, userId: context.userId ?? null }),
    );
    if (documentName === "phase0-denied") {
      const error = new Error("permission-denied") as Error & { reason?: string };
      error.reason = "phase0-denied";
      throw error;
    }
  },
  async onLoadDocument({ documentName }) {
    console.log(JSON.stringify({ event: "spike:onLoadDocument", documentName }));
  },
  async onDisconnect({ documentName, context }) {
    console.log(
      JSON.stringify({ event: "spike:onDisconnect", documentName, userId: context.userId ?? null }),
    );
  },
});

function socketLike(peer: SpikePeer): WebSocketLike {
  return {
    send: (data) =>
      peer.send(typeof data === "string" ? data : new Uint8Array(data as ArrayBufferLike)),
    close: (code, reason) => peer.close(code, reason),
    get readyState() {
      return peer.websocket?.readyState ?? 1;
    },
  };
}

export default defineWebSocketHandler(() => ({
  async upgrade(request) {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "ok";
    if (mode === "close4401") {
      return {
        context: {
          kind: "deferred-close",
          code: 4401,
          reason: "auth_failed",
        } satisfies SpikeContext,
      };
    }
    if (mode === "protocolClose") {
      return {
        context: {
          kind: "protocol-close",
          documentName: url.searchParams.get("doc") ?? "phase0-close-protocol",
          reason: "auth_failed_protocol_close",
        } satisfies SpikeContext,
      };
    }
    return {
      context: {
        kind: "authenticated",
        userId: url.searchParams.get("uid") ?? "phase0-cookie-user",
        mode,
      } satisfies SpikeContext,
    };
  },
  async open(peer) {
    const spikePeer = peer as unknown as SpikePeer;
    const context = spikePeer.context;
    if (context?.kind === "deferred-close") {
      spikePeer.close(context.code, context.reason);
      return;
    }
    if (context?.kind === "protocol-close") {
      spikePeer.send(
        new OutgoingMessage(context.documentName).writeCloseMessage(context.reason).toUint8Array(),
      );
      return;
    }
    spikePeer._hpc = hocuspocus.handleConnection(socketLike(spikePeer), spikePeer.request, {
      userId: context?.userId,
    });
  },
  async message(peer, message) {
    const spikePeer = peer as unknown as SpikePeer;
    spikePeer._hpc?.handleMessage(message.uint8Array());
  },
  async close(peer, event) {
    const spikePeer = peer as unknown as SpikePeer;
    spikePeer._hpc?.handleClose({ code: event?.code ?? 1000, reason: event?.reason ?? "close" });
    delete spikePeer._hpc;
  },
  async error(peer) {
    const spikePeer = peer as unknown as SpikePeer;
    spikePeer._hpc?.handleClose({ code: 1011, reason: "error" });
    delete spikePeer._hpc;
  },
}));
