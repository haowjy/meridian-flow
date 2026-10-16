import { randomUUID } from "node:crypto";
import type { MeridianError } from "@meridian/contracts/interrupt";
import {
  encodeWsServerMessage,
  parseSeq,
  parseWsClientMessage,
  type SequencedEvent,
  WS_CLOSE,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import type { ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import {
  emitEvent,
  runWithEventCorrelation,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import type { SequencedEventInternal } from "../domains/threads/thread-event-hub.js";
import { parseRequestId } from "../shared/uuid.js";
import type { AppServices } from "./app.js";

const SERVER_VERSION = "0.0.0";

export type WsAuthenticatedContext = Readonly<{
  app: Pick<
    AppServices,
    "eventSink" | "threadEventHub" | "projectRepo" | "interruptRegistry" | "contextCatalogWakeHub"
  > & {
    threadRuntime: Pick<AppServices["threadRuntime"], "requireOwnedThread" | "liveState">;
  };
  userId: UserId;
  traceId: string;
}>;

export type WsPeer = {
  request: Request;
  context?: WsAuthenticatedContext;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type WsPeerState = {
  closed: boolean;
  connectionToken: string;
  subscriptions: Map<ThreadId, ThreadSubscriptionSlot>;
  catalogSubscriptions: Map<string, { request: object; unsubscribe?: () => void }>;
};

type ThreadSubscriptionLease = {
  phase: "pending" | "flushing" | "active" | "disposed";
  buffered: SequencedEventInternal[];
  delivered: bigint;
  unsubscribe?: () => void;
};

type ThreadSubscriptionSlot = {
  request: object;
  lease?: ThreadSubscriptionLease;
};

const peerStates = new WeakMap<WsPeer, WsPeerState>();

function getPeerState(peer: WsPeer): WsPeerState {
  let state = peerStates.get(peer);
  if (!state) {
    state = {
      closed: false,
      connectionToken: randomUUID(),
      subscriptions: new Map(),
      catalogSubscriptions: new Map(),
    };
    peerStates.set(peer, state);
  }
  return state;
}

function meridianError(code: string, message: string, retryable = false): MeridianError {
  return { code, message, retryable, source: "system" };
}

function interruptRejectionError(
  reason: "not_found" | "correlation_mismatch",
  message: string,
): MeridianError {
  return meridianError(
    reason === "not_found" ? "interrupt_not_pending" : "interrupt_correlation_mismatch",
    message,
  );
}

function toProtocolSequencedEvent(event: SequencedEventInternal): SequencedEvent {
  return { ...event, seq: event.seq.toString() };
}

function sendFrame(peer: WsPeer, message: WsServerMessage): boolean {
  try {
    peer.send(encodeWsServerMessage(message));
    return true;
  } catch (error) {
    const eventSink = peer.context?.app.eventSink;
    if (eventSink) {
      emitEvent(eventSink, {
        level: "error",
        source: "wire.thread_ws",
        name: "send.failed",
        payload: unknownToEventPayload(error),
      });
    }
    try {
      peer.close(1011, "send_failed");
    } finally {
      disposeSubscriptions(peer);
    }
    return false;
  }
}

/** Every error names the request it answers when it can; a message that failed to parse has none. */
type ErrorScope = { requestId?: string; threadId?: string };

function sendError(peer: WsPeer, error: MeridianError, scope: ErrorScope = {}): boolean {
  return sendFrame(peer, { type: "error", kind: "error", error, ...scope });
}

function runInPeerScope<T>(peer: WsPeer, operation: () => T): T {
  const traceId = peer.context?.traceId;
  return traceId ? runWithEventCorrelation({ traceId }, operation) : operation();
}

function disposeLease(lease: ThreadSubscriptionLease | undefined): void {
  if (!lease || lease.phase === "disposed") return;
  lease.phase = "disposed";
  lease.buffered.length = 0;
  lease.unsubscribe?.();
  lease.unsubscribe = undefined;
}

function sendLiveEvent(
  peer: WsPeer,
  threadId: ThreadId,
  lease: ThreadSubscriptionLease,
  entry: SequencedEventInternal,
): void {
  if ((lease.phase !== "active" && lease.phase !== "flushing") || entry.seq <= lease.delivered)
    return;
  if (
    sendFrame(peer, {
      type: "event",
      threadId,
      ...toProtocolSequencedEvent(entry),
    }) &&
    (lease.phase === "active" || lease.phase === "flushing")
  ) {
    lease.delivered = entry.seq;
  }
}

async function subscribeThread(
  peer: WsPeer,
  requestId: string,
  requestedThreadId: string,
  lastSeq?: string,
): Promise<void> {
  const auth = peer.context;
  if (!auth) {
    sendError(peer, meridianError("auth_failed", "Authenticate before subscribing"), { requestId });
    return;
  }

  const threadId = parseRequestId(requestedThreadId) as ThreadId | null;
  if (!threadId) {
    sendError(peer, meridianError("not_found", "Thread not found"), {
      requestId,
      threadId: requestedThreadId,
    });
    return;
  }
  const subscriptionThreadId = threadId;

  const parsedLastSeq = lastSeq ? parseSeq(lastSeq) : "0";
  if (parsedLastSeq === null) {
    sendError(peer, meridianError("bad_request", "Invalid lastSeq"), { requestId, threadId });
    return;
  }

  const state = getPeerState(peer);
  if (state.closed) return;
  let slot = state.subscriptions.get(threadId);
  if (!slot) {
    slot = { request: {} };
    state.subscriptions.set(threadId, slot);
  }
  const request = {};
  slot.request = request;
  // Request arrival wins. Keep an active lease until this request passes auth,
  // but invalidate an older pending handoff immediately.
  if (slot.lease?.phase !== "active") {
    disposeLease(slot.lease);
    slot.lease = undefined;
  }
  const currentRequest = () =>
    !state.closed && state.subscriptions.get(threadId) === slot && slot.request === request;

  try {
    await auth.app.threadRuntime.requireOwnedThread(threadId, auth.userId);
  } catch {
    if (currentRequest()) {
      sendError(peer, meridianError("not_found", "Thread not found"), { requestId, threadId });
      if (!slot.lease) state.subscriptions.delete(threadId);
    }
    return;
  }

  if (!currentRequest()) return;
  disposeLease(slot.lease);
  const lease: ThreadSubscriptionLease = {
    phase: "pending",
    buffered: [],
    delivered: BigInt(parsedLastSeq),
  };
  const after = lease.delivered;
  slot.lease = lease;
  const currentLease = () =>
    !state.closed &&
    state.subscriptions.get(threadId) === slot &&
    slot.lease === lease &&
    lease.phase !== "disposed";

  try {
    const { catchup, unsubscribe } = await auth.app.threadEventHub.catchupAndSubscribe(
      threadId,
      lease.delivered,
      (entry) => {
        runInPeerScope(peer, () => {
          if (!currentLease()) return;
          lease.buffered.push(entry);
          if (lease.phase === "active") flushBuffered();
        });
      },
    );
    if (!currentLease()) {
      unsubscribe();
      return;
    }
    lease.unsubscribe = unsubscribe;

    const liveState = await auth.app.threadRuntime.liveState(threadId, auth.userId);
    if (!currentLease()) return;
    if (
      !sendFrame(peer, {
        type: "subscribed",
        requestId,
        threadId,
        after: after.toString(),
        catchup: catchup.map(toProtocolSequencedEvent),
        state: liveState,
      }) ||
      !currentLease()
    )
      return;

    for (const entry of catchup) {
      if (entry.seq > lease.delivered) lease.delivered = entry.seq;
    }
    lease.phase = "flushing";
    flushBuffered();
  } catch (error) {
    if (!currentLease()) return;
    disposeLease(lease);
    state.subscriptions.delete(threadId);
    // A failed read is the one retryable subscribe failure: the client asks again.
    emitEvent(auth.app.eventSink, {
      level: "error",
      source: "wire.thread_ws",
      name: "subscribe.failed",
      payload: unknownToEventPayload(error),
    });
    sendError(peer, meridianError("internal", "Could not read the thread", true), {
      requestId,
      threadId,
    });
  }

  function flushBuffered(): void {
    if (!currentLease() || (lease.phase !== "active" && lease.phase !== "flushing")) return;
    lease.phase = "flushing";
    while (currentLease() && lease.buffered.length > 0) {
      const buffered = lease.buffered
        .splice(0)
        .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      for (const entry of buffered) {
        if (!currentLease()) return;
        if (entry.seq <= lease.delivered) continue;
        sendLiveEvent(peer, subscriptionThreadId, lease, entry);
      }
    }
    if (currentLease()) lease.phase = "active";
  }
}

function disposeSubscriptions(peer: WsPeer): void {
  const state = getPeerState(peer);
  state.closed = true;
  for (const slot of state.subscriptions.values()) disposeLease(slot.lease);
  state.subscriptions.clear();
  for (const slot of state.catalogSubscriptions.values()) slot.unsubscribe?.();
  state.catalogSubscriptions.clear();
}

export function createThreadWebSocketSession(peer: WsPeer) {
  return {
    open(): boolean {
      return runInPeerScope(peer, () => {
        const auth = peer.context;
        if (!auth) {
          sendError(peer, meridianError("auth_failed", "Authentication failed"));
          peer.close(WS_CLOSE.AUTH_FAILED.code, WS_CLOSE.AUTH_FAILED.reason);
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
        return sent;
      });
    },

    async onMessage(raw: string | ArrayBuffer) {
      return runInPeerScope(peer, async () => {
        let requestId: string | undefined;
        try {
          const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          const message = parseWsClientMessage(text);
          requestId = message?.type === "pong" ? undefined : message?.requestId;
          if (!message) {
            sendError(peer, meridianError("bad_request", "Malformed WebSocket message"));
            return;
          }

          switch (message.type) {
            case "subscribe":
              await subscribeThread(
                peer,
                message.requestId,
                message.threadId as ThreadId,
                message.lastSeq,
              );
              return;
            case "unsubscribe": {
              const threadId = parseRequestId(message.threadId) as ThreadId | null;
              if (!threadId) {
                sendError(peer, meridianError("not_found", "Thread not found"), {
                  requestId: message.requestId,
                  threadId: message.threadId,
                });
                return;
              }
              const state = getPeerState(peer);
              disposeLease(state.subscriptions.get(threadId)?.lease);
              state.subscriptions.delete(threadId);
              return;
            }
            case "catalog.subscribe": {
              const projectId = parseRequestId(message.projectId);
              if (!projectId || !peer.context) {
                sendError(peer, meridianError("not_found", "Project not found"), {
                  requestId: message.requestId,
                });
                return;
              }
              const state = getPeerState(peer);
              if (state.closed) return;
              let slot = state.catalogSubscriptions.get(projectId);
              if (!slot) {
                slot = { request: {} };
                state.catalogSubscriptions.set(projectId, slot);
              }
              const request = {};
              slot.request = request;
              const currentRequest = () =>
                !state.closed &&
                state.catalogSubscriptions.get(projectId) === slot &&
                slot.request === request;
              try {
                const project = await peer.context.app.projectRepo.findById(projectId as never);
                if (!currentRequest()) return;
                if (!project || project.userId !== peer.context.userId || project.deletedAt) {
                  sendError(peer, meridianError("not_found", "Project not found"), {
                    requestId: message.requestId,
                  });
                  return;
                }
                slot.unsubscribe?.();
                slot.unsubscribe = peer.context.app.contextCatalogWakeHub.subscribe({
                  projectId,
                  userId: peer.context.userId,
                  listener: (hint) => sendFrame(peer, hint),
                });
              } finally {
                if (currentRequest() && !slot.unsubscribe)
                  state.catalogSubscriptions.delete(projectId);
              }
              return;
            }
            case "catalog.unsubscribe": {
              const state = getPeerState(peer);
              state.catalogSubscriptions.get(message.projectId)?.unsubscribe?.();
              state.catalogSubscriptions.delete(message.projectId);
              return;
            }
            case "interrupt.respond": {
              const threadId = parseRequestId(message.threadId) as ThreadId | null;
              if (!threadId) {
                sendError(peer, meridianError("not_found", "Thread not found"), {
                  requestId: message.requestId,
                  threadId: message.threadId,
                });
                return;
              }
              const turnId = parseRequestId(message.turnId);
              if (!turnId) {
                sendError(peer, meridianError("not_found", "Turn not found"), {
                  requestId: message.requestId,
                  threadId,
                });
                return;
              }
              const context = peer.context;
              try {
                if (!context) throw new Error("Missing peer context");
                await context.app.threadRuntime.requireOwnedThread(threadId, context.userId);
              } catch {
                sendError(peer, meridianError("not_found", "Thread not found"), {
                  requestId: message.requestId,
                  threadId,
                });
                return;
              }
              const result = context.app.interruptRegistry.resolve({
                threadId,
                turnId: turnId as TurnId,
                interruptId: message.interruptId,
                value: message.value as JsonValue,
              });
              if (!result.ok) {
                sendError(peer, interruptRejectionError(result.reason, result.message), {
                  requestId: message.requestId,
                  threadId,
                });
              }
              return;
            }
            case "pong":
              return;
          }
        } catch (error) {
          const eventSink = peer.context?.app.eventSink;
          if (eventSink) {
            emitEvent(eventSink, {
              level: "error",
              source: "wire.thread_ws",
              name: "message.failed",
              payload: unknownToEventPayload(error),
            });
          }
          sendError(peer, meridianError("internal", "Internal server error"), { requestId });
        }
      });
    },

    onClose() {
      runInPeerScope(peer, () => disposeSubscriptions(peer));
    },

    onError() {
      runInPeerScope(peer, () => disposeSubscriptions(peer));
    },
  };
}
