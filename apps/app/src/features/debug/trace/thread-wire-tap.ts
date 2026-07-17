/** Maps content-free thread WebSocket metadata into the shared observability schema. */

import type { EventCorrelation, EventRecord } from "@meridian/contracts/observability";
import { EventType } from "@meridian/contracts/protocol";

import type { ThreadWireTap, WireDirection } from "@/core/transport/wire-tap";

const SOURCE = "wire.thread";
const SERVER_MESSAGE_CLASSES = new Set([
  "connected",
  "subscribed",
  "event",
  "gap",
  "error",
  "ping",
]);
const CLIENT_MESSAGE_CLASSES = new Set([
  "subscribe",
  "unsubscribe",
  "resume",
  "pong",
  "interrupt.respond",
]);
const AGUI_EVENT_TYPES = new Set<string>(Object.values(EventType));
const EVENT_SEQ_PATTERN = /^(0|[1-9]\d*)$/;
const textEncoder = new TextEncoder();

type ThreadFrameMetadata = {
  messageClass: string;
  threadId?: string;
  seq?: string;
  eventType?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Allowlist every copied classification so arbitrary payload strings can never
 * become searchable records. Nested data is ignored except the event type
 * discriminant on a single sequenced `event` frame.
 */
function inspectThreadFrame(direction: WireDirection, data: string): ThreadFrameMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { messageClass: "unknown" };
  }
  if (!isRecord(parsed)) return { messageClass: "unknown" };

  const allowedClasses =
    direction === "server_to_client" ? SERVER_MESSAGE_CLASSES : CLIENT_MESSAGE_CLASSES;
  const messageClass =
    typeof parsed.type === "string" && allowedClasses.has(parsed.type) ? parsed.type : "unknown";
  if (messageClass === "unknown") return { messageClass };

  const threadId = typeof parsed.threadId === "string" ? parsed.threadId : undefined;
  const seq =
    messageClass === "event" && typeof parsed.seq === "string" && EVENT_SEQ_PATTERN.test(parsed.seq)
      ? parsed.seq
      : undefined;
  const eventType =
    messageClass === "event" &&
    isRecord(parsed.event) &&
    typeof parsed.event.type === "string" &&
    AGUI_EVENT_TYPES.has(parsed.event.type)
      ? parsed.event.type
      : undefined;

  return { messageClass, threadId, seq, eventType };
}

export interface ThreadWireTapState {
  observerSeq: number;
}

export function createThreadWireTapState(): ThreadWireTapState {
  return { observerSeq: 0 };
}

export function createThreadWireTap(
  emit: (record: EventRecord) => void,
  onError: () => void,
  state = createThreadWireTapState(),
): ThreadWireTap {
  function reportError(): void {
    try {
      onError();
    } catch {
      // Error accounting is observational too and cannot escape into transport.
    }
  }

  return {
    onStringFrame(direction, data, socketEpoch) {
      try {
        const metadata = inspectThreadFrame(direction, data);
        const correlation: EventCorrelation = metadata.threadId
          ? { threadId: metadata.threadId }
          : {};
        const streamId = metadata.threadId ? `thread:${metadata.threadId}` : "thread:socket";

        emit({
          timestamp: new Date().toISOString(),
          level: "trace",
          source: SOURCE,
          name: metadata.messageClass,
          sensitivity: "safe",
          ...(metadata.threadId ? { correlation } : {}),
          stream: {
            streamId,
            transport: "thread",
            direction,
            observedAt: "client",
            messageClass: metadata.messageClass,
            bytes: textEncoder.encode(data).byteLength,
            observerSeq: ++state.observerSeq,
          },
          payload: {
            socketEpoch,
            ...(metadata.seq ? { seq: metadata.seq } : {}),
            ...(metadata.eventType ? { eventType: metadata.eventType } : {}),
          },
        });
      } catch {
        reportError();
      }
    },

    onSocketOpen(socketEpoch) {
      try {
        emit({
          timestamp: new Date().toISOString(),
          level: "debug",
          source: SOURCE,
          name: "socket.open",
          sensitivity: "safe",
          stream: {
            streamId: "thread:socket",
            transport: "thread",
            observedAt: "client",
            observerSeq: ++state.observerSeq,
          },
          payload: { socketEpoch },
        });
      } catch {
        reportError();
      }
    },

    onSocketClose(socketEpoch, code, wasClean) {
      try {
        emit({
          timestamp: new Date().toISOString(),
          level: "debug",
          source: SOURCE,
          name: "socket.close",
          sensitivity: "safe",
          stream: {
            streamId: "thread:socket",
            transport: "thread",
            observedAt: "client",
            observerSeq: ++state.observerSeq,
          },
          payload: { socketEpoch, code, wasClean },
        });
      } catch {
        reportError();
      }
    },
  };
}
