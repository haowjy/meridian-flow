/** Dev-only native WebSocket adapter that exposes final wire frames to observers. */

export type YjsWireDirection = "client_to_server" | "server_to_client";

export interface YjsWireTap {
  onFrame(direction: YjsWireDirection, bytes: Uint8Array, socketEpoch: number): void;
  onSocketOpen(socketEpoch: number, url: string): void;
  onSocketClose(socketEpoch: number, code: number, reason: string, wasClean: boolean): void;
  /** Correlation aid: a document transport attached a room on the shared socket. */
  onRoomAttached(roomName: string, yjsClient: number): void;
}

export interface ThreadWireTap {
  onStringFrame(direction: YjsWireDirection, data: string, socketEpoch: number): void;
  onSocketOpen(socketEpoch: number): void;
  onSocketClose(socketEpoch: number, code: number, wasClean: boolean): void;
}

export type TappedWebSocketTransport = "yjs" | "thread";

let currentYjsTap: YjsWireTap | null = null;
let currentThreadTap: ThreadWireTap | null = null;
let nextSocketEpoch = 0;

export function setYjsWireTap(tap: YjsWireTap): void {
  currentYjsTap = tap;
}

export function setThreadWireTap(tap: ThreadWireTap): void {
  currentThreadTap = tap;
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
  direction: YjsWireDirection,
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

function notifyStringFrame(
  tap: ThreadWireTap,
  direction: YjsWireDirection,
  data: string,
  socketEpoch: number,
): void {
  try {
    tap.onStringFrame(direction, data, socketEpoch);
  } catch {
    // Observability must never affect thread transport behavior.
  }
}

/** A native WebSocket with synchronous, non-owning observation of final frames. */
export class TappedWebSocket extends WebSocket {
  readonly #socketEpoch: number;
  readonly #transport: TappedWebSocketTransport;

  constructor(
    url: string | URL,
    protocols?: string | string[],
    transport: TappedWebSocketTransport = "yjs",
  ) {
    super(url, protocols);
    this.#socketEpoch = ++nextSocketEpoch;
    this.#transport = transport;

    this.addEventListener("open", () => {
      try {
        if (this.#transport === "thread") {
          currentThreadTap?.onSocketOpen(this.#socketEpoch);
        } else {
          currentYjsTap?.onSocketOpen(this.#socketEpoch, this.url);
        }
      } catch {
        // Observability must never affect transport behavior.
      }
    });
    this.addEventListener("close", (event) => {
      try {
        if (this.#transport === "thread") {
          currentThreadTap?.onSocketClose(this.#socketEpoch, event.code, event.wasClean);
        } else {
          currentYjsTap?.onSocketClose(this.#socketEpoch, event.code, event.reason, event.wasClean);
        }
      } catch {
        // Observability must never affect transport behavior.
      }
    });
    this.addEventListener("message", (event) => {
      if (this.#transport === "thread") {
        const tap = currentThreadTap;
        if (tap && typeof event.data === "string") {
          notifyStringFrame(tap, "server_to_client", event.data, this.#socketEpoch);
        }
        return;
      }
      const tap = currentYjsTap;
      if (tap && event.data instanceof ArrayBuffer) {
        notifyFrame(tap, "server_to_client", event.data, this.#socketEpoch);
      }
    });
  }

  override send(data: string | ArrayBuffer | Blob | ArrayBufferView<ArrayBuffer>): void {
    if (this.#transport === "thread") {
      const tap = currentThreadTap;
      if (tap && typeof data === "string") {
        notifyStringFrame(tap, "client_to_server", data, this.#socketEpoch);
      }
      super.send(data);
      return;
    }

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
