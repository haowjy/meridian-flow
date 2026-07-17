/** Dev-only native WebSocket adapter that exposes final wire frames to observers. */

import type { WireDirection } from "./wire-tap";

export interface YjsWireTap {
  onFrame(direction: WireDirection, bytes: Uint8Array, socketEpoch: number): void;
  onSocketOpen(socketEpoch: number, url: string): void;
  onSocketClose(socketEpoch: number, code: number, reason: string, wasClean: boolean): void;
  /** Correlation aid: a document transport attached a room on the shared socket. */
  onRoomAttached(roomName: string, yjsClient: number): void;
}

let currentYjsTap: YjsWireTap | null = null;
let nextSocketEpoch = 0;

export function setYjsWireTap(tap: YjsWireTap): void {
  currentYjsTap = tap;
}

export function notifyYjsRoomAttached(roomName: string, yjsClient: number): void {
  try {
    currentYjsTap?.onRoomAttached(roomName, yjsClient);
  } catch {
    // Observability must never affect document transport behavior.
  }
}

function notifyFrame(
  tap: YjsWireTap,
  direction: WireDirection,
  data: ArrayBuffer | ArrayBufferView<ArrayBuffer>,
  socketEpoch: number,
): void {
  const bytes =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  try {
    tap.onFrame(direction, bytes, socketEpoch);
  } catch {
    // Observability must never affect document transport behavior.
  }
}

/** A native WebSocket with synchronous, non-owning observation of final frames. */
export class TappedWebSocket extends WebSocket {
  readonly #socketEpoch: number;

  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.#socketEpoch = ++nextSocketEpoch;

    this.addEventListener("open", () => {
      try {
        currentYjsTap?.onSocketOpen(this.#socketEpoch, this.url);
      } catch {
        // Observability must never affect transport behavior.
      }
    });
    this.addEventListener("close", (event) => {
      try {
        currentYjsTap?.onSocketClose(this.#socketEpoch, event.code, event.reason, event.wasClean);
      } catch {
        // Observability must never affect transport behavior.
      }
    });
    this.addEventListener("message", (event) => {
      const tap = currentYjsTap;
      if (tap && event.data instanceof ArrayBuffer) {
        notifyFrame(tap, "server_to_client", event.data, this.#socketEpoch);
      }
    });
  }

  override send(data: string | ArrayBuffer | Blob | ArrayBufferView<ArrayBuffer>): void {
    const tap = currentYjsTap;
    if (!tap) {
      super.send(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      notifyFrame(tap, "client_to_server", data, this.#socketEpoch);
    } else if (ArrayBuffer.isView(data)) {
      notifyFrame(tap, "client_to_server", data, this.#socketEpoch);
    }
    // Hocuspocus sends binary frames. Unexpected strings or Blobs still pass
    // through unchanged rather than broadening the Yjs observer's byte contract.
    super.send(data);
  }
}
