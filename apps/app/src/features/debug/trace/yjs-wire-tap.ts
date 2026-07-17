/** Maps metadata-only Yjs wire inspections into the shared observability schema. */

import type { EventCorrelation, EventRecord } from "@meridian/contracts/observability";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import { inspectFrame, type UpdateSummary } from "@meridian/yjs-inspect";

import type { YjsWireTap } from "@/core/transport/tapped-websocket";

const SOURCE = "wire.yjs";

function streamIdentity(documentName: string | null): {
  streamId: string;
  correlation: EventCorrelation;
} {
  if (documentName === null) return { streamId: "yjs:socket", correlation: {} };
  const room = parseYjsRoomName(documentName);
  if (!room) return { streamId: "yjs:socket", correlation: {} };
  if (room.kind === "live") {
    return {
      streamId: `yjs:live:${room.documentId}`,
      correlation: { documentId: room.documentId },
    };
  }
  return {
    streamId: `yjs:branch:${room.branchId}:gen:${room.generation}`,
    correlation: { branchId: room.branchId, branchGeneration: room.generation },
  };
}

function singleStructClient(update: UpdateSummary | undefined): number | undefined {
  if (!update) return undefined;
  const clients = new Set(update.structSpans.map((span) => span.client));
  return clients.size === 1 ? clients.values().next().value : undefined;
}

export interface YjsWireTapState {
  observerSeq: number;
  roomClients: Map<string, number>;
}

export function createYjsWireTapState(): YjsWireTapState {
  return { observerSeq: 0, roomClients: new Map() };
}

export function createYjsWireTap(
  emit: (record: EventRecord) => void,
  onError: () => void,
  state = createYjsWireTapState(),
): YjsWireTap {
  function reportError(): void {
    try {
      onError();
    } catch {
      // Error accounting is observational too and cannot escape into transport.
    }
  }

  return {
    onFrame(direction, bytes, socketEpoch) {
      try {
        const inspection = inspectFrame(bytes);
        const { frame, update } = inspection;
        const identity = streamIdentity(frame.documentName);
        const correlation = identity.correlation;
        if (update) correlation.yjsSpans = update.spansKey;

        const yjsClient =
          direction === "client_to_server"
            ? frame.documentName === null
              ? undefined
              : state.roomClients.get(frame.documentName)
            : singleStructClient(update);
        if (yjsClient !== undefined) correlation.yjsClient = yjsClient;

        emit({
          timestamp: new Date().toISOString(),
          level: "trace",
          source: SOURCE,
          name:
            frame.messageClass === "awareness"
              ? "awareness"
              : frame.messageClass === "stateless"
                ? "stateless"
                : "frame",
          sensitivity: "safe",
          ...(Object.keys(correlation).length > 0 ? { correlation } : {}),
          stream: {
            streamId: identity.streamId,
            transport: "yjs",
            direction,
            observedAt: "client",
            messageClass: frame.messageClass,
            bytes: bytes.byteLength,
            observerSeq: ++state.observerSeq,
          },
          payload: { socketEpoch, ...inspection },
        });
      } catch {
        reportError();
      }
    },

    onSocketOpen(socketEpoch, url) {
      try {
        emit({
          timestamp: new Date().toISOString(),
          level: "debug",
          source: SOURCE,
          name: "socket.open",
          sensitivity: "safe",
          stream: {
            streamId: "yjs:socket",
            transport: "yjs",
            observedAt: "client",
            observerSeq: ++state.observerSeq,
          },
          payload: { socketEpoch, url },
        });
      } catch {
        reportError();
      }
    },

    onSocketClose(socketEpoch, code, reason, wasClean) {
      try {
        emit({
          timestamp: new Date().toISOString(),
          level: "debug",
          source: SOURCE,
          name: "socket.close",
          sensitivity: "safe",
          stream: {
            streamId: "yjs:socket",
            transport: "yjs",
            observedAt: "client",
            observerSeq: ++state.observerSeq,
          },
          payload: { socketEpoch, code, reason, wasClean },
        });
      } catch {
        reportError();
      }
    },

    onRoomAttached(roomName, yjsClient) {
      try {
        state.roomClients.set(roomName, yjsClient);
      } catch {
        reportError();
      }
    },
  };
}
