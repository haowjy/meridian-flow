import type { YjsControlErrorCode } from "@meridian/contracts/protocol";
import {
  encodeYjsBinaryEnvelope,
  encodeYjsControlFrame,
  parseYjsClientControlFrame,
} from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import { defineWebSocketHandler } from "nitro";
import type { AppServices } from "../../lib/app.js";
import { resolveWsUpgradeAuth, type WsDeferredClose } from "../../lib/ws-upgrade-auth.js";

type YjsRouteContext =
  | { kind: "authenticated"; app: AppServices; userId: UserId }
  | { kind: "deferred-close"; close: WsDeferredClose };

type YjsPeer = {
  context?: YjsRouteContext;
  send: (data: string | Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
};

type YjsPeerState = {
  nextChannelIndex: number;
  documentToChannel: Map<DocumentId, number>;
  channelToDocument: Map<number, DocumentId>;
  subscriptions: Map<DocumentId, () => void>;
};

const states = new WeakMap<YjsPeer, YjsPeerState>();

function stateFor(peer: YjsPeer): YjsPeerState {
  let state = states.get(peer);
  if (!state) {
    state = {
      nextChannelIndex: 0,
      documentToChannel: new Map(),
      channelToDocument: new Map(),
      subscriptions: new Map(),
    };
    states.set(peer, state);
  }
  return state;
}

function sendError(
  peer: YjsPeer,
  code: YjsControlErrorCode,
  documentId?: DocumentId,
  reason = code,
): void {
  peer.send(
    encodeYjsControlFrame({
      type: "error",
      code,
      reason,
      documentId,
    }),
  );
}

function dispose(peer: YjsPeer): void {
  const state = states.get(peer);
  if (!state) return;
  for (const unsubscribe of state.subscriptions.values()) unsubscribe();
  states.delete(peer);
}

export default defineWebSocketHandler(() => ({
  async upgrade(request) {
    const auth = await resolveWsUpgradeAuth(request, { logPrefix: "ws-yjs-route" });
    if (auth.kind === "deferred-close") {
      return {
        context: { kind: "deferred-close", close: auth.close } satisfies YjsRouteContext,
      };
    }
    return {
      context: {
        kind: "authenticated",
        app: auth.app,
        userId: auth.userId,
      } satisfies YjsRouteContext,
    };
  },

  open(peer) {
    const yjsPeer = peer as unknown as YjsPeer;
    const context = yjsPeer.context;
    if (context?.kind === "deferred-close") {
      sendError(yjsPeer, "auth_failed");
      yjsPeer.close(context.close.code, context.close.reason);
    }
  },

  async message(peer, message) {
    const yjsPeer = peer as unknown as YjsPeer;
    const context = yjsPeer.context;
    if (context?.kind !== "authenticated") {
      sendError(yjsPeer, "auth_failed");
      return;
    }

    const text = message.text();
    const control = parseYjsClientControlFrame(text);
    if (!control) {
      sendError(yjsPeer, "bad_request");
      return;
    }

    if (control.type === "unsubscribe") {
      const documentId = control.documentId as DocumentId;
      const state = stateFor(yjsPeer);
      state.subscriptions.get(documentId)?.();
      state.subscriptions.delete(documentId);
      return;
    }

    const documentId = control.documentId as DocumentId;
    try {
      await context.app.documentSync.requireOwnedDocument(documentId, context.userId);
    } catch {
      sendError(yjsPeer, "document_not_found", documentId);
      return;
    }

    const state = stateFor(yjsPeer);
    state.subscriptions.get(documentId)?.();
    const channelIndex = state.documentToChannel.get(documentId) ?? state.nextChannelIndex++;
    state.documentToChannel.set(documentId, channelIndex);
    state.channelToDocument.set(channelIndex, documentId);
    let unsubscribe: () => void = () => undefined;
    unsubscribe = context.app.documentSync.subscribe(documentId, (update) => {
      try {
        yjsPeer.send(encodeYjsBinaryEnvelope(channelIndex, update.updateData));
      } catch {
        unsubscribe();
        state.subscriptions.delete(documentId);
        state.documentToChannel.delete(documentId);
        state.channelToDocument.delete(channelIndex);
      }
    });
    state.subscriptions.set(documentId, unsubscribe);
    yjsPeer.send(encodeYjsControlFrame({ type: "subscribed", documentId, channelIndex }));
  },

  close(peer) {
    dispose(peer as unknown as YjsPeer);
  },

  error(peer) {
    dispose(peer as unknown as YjsPeer);
  },
}));
