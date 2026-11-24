import type { EventCorrelation, EventRecord } from "@meridian/contracts/observability";
import { LORO_JOIN_ERROR, loroRoomErrorOf, parseLoroRoomName } from "@meridian/contracts/protocol";
import { CrdtType, MessageType, type ProtocolMessage } from "loro-protocol";

import type { LoroWireTap } from "@/core/transport/wire-tap";

const SOURCE = "wire.loro";
const MESSAGE_CLASS: Readonly<Record<number, string>> = {
  [MessageType.JoinRequest]: "join.request",
  [MessageType.JoinResponseOk]: "join.ok",
  [MessageType.JoinError]: "join.error",
  [MessageType.DocUpdate]: "update",
  [MessageType.DocUpdateFragmentHeader]: "update.fragment_header",
  [MessageType.DocUpdateFragment]: "update.fragment",
  [MessageType.RoomError]: "room.error",
  [MessageType.Leave]: "leave",
  [MessageType.Ack]: "ack",
};
const JOIN_APP_CODES = new Set<string>(
  Object.values(LORO_JOIN_ERROR).map((entry) => entry.appCode),
);

function roomCorrelation(roomId: string): EventCorrelation {
  const room = parseLoroRoomName(roomId);
  if (room?.kind === "live") return { documentId: room.documentId };
  if (room?.kind === "fork") return { documentId: room.documentId, draftId: room.draftId };
  return {};
}

// keep: Trace only room metadata; keep update bytes, the Join's auth and versions out and allowlist error text (leak hazard).
function summarize(message: ProtocolMessage): {
  messageClass: string;
  batchId?: string;
  payload: Record<string, unknown>;
} {
  const messageClass = MESSAGE_CLASS[message.type] ?? "unknown";
  const channel = message.crdt === CrdtType.LoroEphemeralStore ? "presence" : "doc";
  switch (message.type) {
    case MessageType.JoinResponseOk:
      return { messageClass, payload: { channel, permission: message.permission } };
    case MessageType.JoinError:
      return {
        messageClass,
        payload: {
          channel,
          code: message.code,
          ...(message.appCode && JOIN_APP_CODES.has(message.appCode)
            ? { appCode: message.appCode }
            : {}),
        },
      };
    case MessageType.DocUpdate:
      return {
        messageClass,
        batchId: message.batchId,
        payload: { channel, updates: message.updates.length },
      };
    case MessageType.DocUpdateFragmentHeader:
      return {
        messageClass,
        batchId: message.batchId,
        payload: {
          channel,
          fragmentCount: message.fragmentCount,
          totalSizeBytes: message.totalSizeBytes,
        },
      };
    case MessageType.DocUpdateFragment:
      return { messageClass, batchId: message.batchId, payload: { channel, index: message.index } };
    case MessageType.RoomError: {
      const known = loroRoomErrorOf(message.message);
      return {
        messageClass,
        payload: { channel, code: message.code, ...(known ? { reason: known.reason } : {}) },
      };
    }
    case MessageType.Ack:
      return { messageClass, batchId: message.refId, payload: { channel, status: message.status } };
    default:
      return { messageClass, payload: { channel } };
  }
}

export interface LoroWireTapState {
  observerSeq: number;
}

export function createLoroWireTapState(): LoroWireTapState {
  return { observerSeq: 0 };
}

export function createLoroWireTap(
  emit: (record: EventRecord) => void,
  onError: () => void,
  state = createLoroWireTapState(),
): LoroWireTap {
  function lifecycle(roomId: string, name: string, payload: Record<string, unknown>): void {
    const correlation = roomCorrelation(roomId);
    emit({
      timestamp: new Date().toISOString(),
      level: "debug",
      source: SOURCE,
      name,
      sensitivity: "safe",
      ...(Object.keys(correlation).length > 0 ? { correlation } : {}),
      stream: {
        streamId: `loro:${roomId}`,
        transport: "loro",
        observedAt: "client",
        messageClass: name,
        observerSeq: ++state.observerSeq,
      },
      payload,
    });
  }

  return {
    onMessage(direction, roomId, message, bytes) {
      try {
        const described = summarize(message);
        const correlation = roomCorrelation(roomId);
        if (described.batchId) correlation.batchId = described.batchId;
        emit({
          timestamp: new Date().toISOString(),
          level: "trace",
          source: SOURCE,
          name: "frame",
          sensitivity: "safe",
          ...(Object.keys(correlation).length > 0 ? { correlation } : {}),
          stream: {
            streamId: `loro:${roomId}`,
            transport: "loro",
            direction,
            observedAt: "client",
            messageClass: described.messageClass,
            bytes,
            observerSeq: ++state.observerSeq,
          },
          payload: described.payload,
        });
      } catch {
        onError();
      }
    },

    onSocketOpen(roomId, attempt) {
      try {
        lifecycle(roomId, "socket.open", { attempt });
      } catch {
        onError();
      }
    },

    onSocketClose(roomId, attempt, code, wasClean) {
      try {
        lifecycle(roomId, "socket.close", { attempt, code, wasClean });
      } catch {
        onError();
      }
    },
  };
}
