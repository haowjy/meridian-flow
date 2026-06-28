import { randomUUID } from "node:crypto";
import type { MeridianError } from "@meridian/contracts/interrupt";
import {
  encodeWsServerMessage,
  parseSeq,
  parseWsClientMessage,
  type SequencedEvent,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import type { SequencedEventInternal } from "../domains/threads/thread-event-hub.js";
import type { AppServices } from "./app.js";

const SERVER_VERSION = "0.0.0";

export type WsAuthenticatedContext = {
  app: AppServices;
  userId: UserId;
};

export type WsPeer = {
  request: Request;
  context?: WsAuthenticatedContext;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type WsPeerState = {
  closed: boolean;
  connectionToken: string;
  subscriptions: Map<ThreadId, () => void>;
  liveWatermark: Map<ThreadId, bigint>;
};

const peerStates = new WeakMap<WsPeer, WsPeerState>();

function getPeerState(peer: WsPeer): WsPeerState {
  let state = peerStates.get(peer);
  if (!state) {
    state = {
      closed: false,
      connectionToken: randomUUID(),
      subscriptions: new Map(),
      liveWatermark: new Map(),
    };
    peerStates.set(peer, state);
  }
  return state;
}

function meridianError(code: string, message: string): MeridianError {
  return { code, message, retryable: false, source: "system" };
}

function checkpointRejectionError(
  reason: "not_found" | "correlation_mismatch",
  message: string,
): MeridianError {
  return meridianError(
    reason === "not_found" ? "checkpoint_not_pending" : "checkpoint_correlation_mismatch",
    message,
  );
}

function toProtocolSequencedEvent(event: SequencedEventInternal): SequencedEvent {
  return { seq: event.seq.toString(), event: event.event };
}

function sendFrame(peer: WsPeer, message: WsServerMessage): boolean {
  try {
    peer.send(encodeWsServerMessage(message));
    return true;
  } catch (error) {
    console.error("ws-thread-handler: send failed", error);
    peer.close(1011, "send_failed");
    disposeSubscriptions(peer);
    return false;
  }
}

function sendError(peer: WsPeer, error: MeridianError, threadId?: string): boolean {
  return sendFrame(peer, { type: "error", kind: "error", error, threadId });
}

async function subscribeThread(peer: WsPeer, threadId: ThreadId, lastSeq?: string): Promise<void> {
  const auth = peer.context;
  if (!auth) {
    sendError(peer, meridianError("auth_failed", "Authenticate before subscribing"));
    return;
  }

  const parsedLastSeq = lastSeq ? parseSeq(lastSeq) : "0";
  if (parsedLastSeq === null) {
    sendError(peer, meridianError("bad_request", "Invalid lastSeq"), threadId);
    return;
  }

  try {
    await auth.app.threadRuntime.requireOwnedThread(threadId, auth.userId);
  } catch {
    sendError(peer, meridianError("not_found", "Thread not found"), threadId);
    return;
  }

  const state = getPeerState(peer);
  state.subscriptions.get(threadId)?.();

  let watermark = BigInt(parsedLastSeq);
  const { catchup, hitReplayLimit, unsubscribe } =
    await auth.app.threadEventHub.catchupAndSubscribe(threadId, watermark, (entry) => {
      if (state.closed) return;
      const minSeq = state.liveWatermark.get(threadId) ?? 0n;
      if (entry.seq <= minSeq) return;
      state.liveWatermark.set(threadId, entry.seq);
      sendFrame(peer, {
        type: "event",
        threadId,
        seq: entry.seq.toString(),
        event: entry.event,
      });
    });

  for (const entry of catchup) {
    if (entry.seq > watermark) watermark = entry.seq;
  }

  if (state.closed) {
    unsubscribe();
    return;
  }

  state.liveWatermark.set(threadId, watermark);
  state.subscriptions.set(threadId, unsubscribe);

  if (hitReplayLimit) {
    sendFrame(peer, {
      type: "gap",
      threadId,
      cause: "replay_limit_exceeded",
      message: "Journal replay capped at 10000 events",
    });
  }

  const liveState = await auth.app.threadRuntime.liveState(threadId, auth.userId);
  sendFrame(peer, {
    type: "subscribed",
    threadId,
    catchup: catchup.map(toProtocolSequencedEvent),
    state: liveState,
    nextSeq: liveState.nextSeq,
  });
}

function disposeSubscriptions(peer: WsPeer): void {
  const state = getPeerState(peer);
  state.closed = true;
  unregisterPeerConnectionToken(peer);
  for (const unsubscribe of state.subscriptions.values()) unsubscribe();
  state.subscriptions.clear();
  state.liveWatermark.clear();
}

function unregisterPeerConnectionToken(peer: WsPeer): void {
  const auth = peer.context;
  if (!auth) return;
  auth.app.runner.unregisterLiveConnectionToken?.(getPeerState(peer).connectionToken);
}

export function createThreadWebSocketSession(peer: WsPeer) {
  return {
    open(): boolean {
      const auth = peer.context;
      if (!auth) {
        sendError(peer, meridianError("auth_failed", "Authentication failed"));
        peer.close(4401, "auth_failed");
        return false;
      }

      const connectionToken = getPeerState(peer).connectionToken;
      const sent = sendFrame(peer, {
        type: "connected",
        userId: auth.userId,
        scope: { type: "standalone" },
        serverVersion: SERVER_VERSION,
        connectionToken,
      });
      if (sent) {
        auth.app.runner.registerLiveConnectionToken?.(connectionToken);
      }
      return sent;
    },

    async onMessage(raw: string | ArrayBuffer) {
      try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        const message = parseWsClientMessage(text);
        if (!message) {
          sendError(peer, meridianError("bad_request", "Malformed WebSocket message"));
          return;
        }

        switch (message.type) {
          case "subscribe":
            await subscribeThread(peer, message.threadId as ThreadId, message.lastSeq);
            return;
          case "resume":
            for (const subscription of message.subscriptions) {
              await subscribeThread(peer, subscription.threadId as ThreadId, subscription.lastSeq);
            }
            return;
          case "unsubscribe": {
            const threadId = message.threadId as ThreadId;
            const state = getPeerState(peer);
            state.subscriptions.get(threadId)?.();
            state.subscriptions.delete(threadId);
            state.liveWatermark.delete(threadId);
            return;
          }
          case "checkpoint.respond": {
            const threadId = message.threadId as ThreadId;
            const context = peer.context;
            try {
              if (!context) throw new Error("Missing peer context");
              await context.app.threadRuntime.requireOwnedThread(threadId, context.userId);
            } catch {
              sendError(peer, meridianError("not_found", "Thread not found"), threadId);
              return;
            }
            const result = context.app.checkpointRegistry.resolve({
              threadId,
              turnId: message.turnId as never,
              checkpointId: message.checkpointId,
              value: message.value as JsonValue,
            });
            if (!result.ok) {
              sendError(peer, checkpointRejectionError(result.reason, result.message), threadId);
            }
            return;
          }
          case "pong":
            return;
        }
      } catch (error) {
        console.error("ws-thread-handler: message failed", error);
        sendError(peer, meridianError("internal", "Internal server error"));
      }
    },

    onClose() {
      disposeSubscriptions(peer);
    },

    onError() {
      disposeSubscriptions(peer);
    },
  };
}
