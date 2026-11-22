/** Late-bound observer seams for the thread WebSocket and the Loro room sockets. */

import type { ProtocolMessage } from "loro-protocol";

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

/**
 * Late-bound observer seam for each Loro room socket: its lifecycle and every decoded message.
 * The transport calls it inline, so an implementation catches its own failures and never throws.
 */
export interface LoroWireTap {
  onMessage(
    direction: WireDirection,
    roomId: string,
    message: ProtocolMessage,
    bytes: number,
  ): void;
  onSocketOpen(roomId: string, attempt: number): void;
  onSocketClose(roomId: string, attempt: number, code: number, wasClean: boolean): void;
}

let currentLoroTap: LoroWireTap | null = null;

export function setLoroWireTap(tap: LoroWireTap): void {
  currentLoroTap = tap;
}

export function notifyLoroMessage(
  direction: WireDirection,
  roomId: string,
  message: ProtocolMessage,
  bytes: number,
): void {
  currentLoroTap?.onMessage(direction, roomId, message, bytes);
}

export function notifyLoroSocketOpen(roomId: string, attempt: number): void {
  currentLoroTap?.onSocketOpen(roomId, attempt);
}

export function notifyLoroSocketClose(
  roomId: string,
  attempt: number,
  code: number,
  wasClean: boolean,
): void {
  currentLoroTap?.onSocketClose(roomId, attempt, code, wasClean);
}
