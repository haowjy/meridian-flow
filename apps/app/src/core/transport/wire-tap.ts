/**
 * Late-bound observer seams for the thread WebSocket and the Loro room sockets. The transports
 * call a tap inline, so a tap catches its own failures and never throws.
 */

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
  currentThreadTap?.onStringFrame(direction, data, socketEpoch);
}

export function notifyThreadSocketOpen(socketEpoch: number): void {
  currentThreadTap?.onSocketOpen(socketEpoch);
}

export function notifyThreadSocketClose(
  socketEpoch: number,
  code: number,
  wasClean: boolean,
): void {
  currentThreadTap?.onSocketClose(socketEpoch, code, wasClean);
}

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
