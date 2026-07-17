/** Late-bound observer seam for thread WebSocket lifecycle and final string frames. */

export type WireDirection = "client_to_server" | "server_to_client";

export interface ThreadWireTap {
  onStringFrame(direction: WireDirection, data: string, socketEpoch: number): void;
  onSocketOpen(socketEpoch: number): void;
  onSocketClose(socketEpoch: number, code: number, wasClean: boolean): void;
}

let currentThreadTap: ThreadWireTap | null = null;

export function setThreadWireTap(tap: ThreadWireTap): void {
  currentThreadTap = tap;
}

export function notifyThreadFrame(
  direction: WireDirection,
  data: string,
  socketEpoch: number,
): void {
  try {
    currentThreadTap?.onStringFrame(direction, data, socketEpoch);
  } catch {
    // Observability must never affect thread transport behavior.
  }
}

export function notifyThreadSocketOpen(socketEpoch: number): void {
  try {
    currentThreadTap?.onSocketOpen(socketEpoch);
  } catch {
    // Observability must never affect thread transport behavior.
  }
}

export function notifyThreadSocketClose(
  socketEpoch: number,
  code: number,
  wasClean: boolean,
): void {
  try {
    currentThreadTap?.onSocketClose(socketEpoch, code, wasClean);
  } catch {
    // Observability must never affect thread transport behavior.
  }
}
