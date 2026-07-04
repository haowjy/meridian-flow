/**
 * Purpose: Defines the Yjs WebSocket path and room-name wire contract shared by collaborative sync clients and server handlers.
 * Why independent: Path constants and room names are protocol primitives shared across the frontend editor and server WebSocket adapter.
 */
import type { DocumentId } from "../runtime/index.js";

export const YJS_WS_PATH_PREFIX = "/ws/yjs";
export const YJS_DRAFT_ROOM_PREFIX = "draft:";

export type YjsRoomName =
  | { kind: "live"; documentId: DocumentId }
  | { kind: "draft"; draftId: string };

export function yjsWsPath(): string {
  return YJS_WS_PATH_PREFIX;
}

export function draftRoomName(draftId: string): string {
  return `${YJS_DRAFT_ROOM_PREFIX}${draftId}`;
}

export function parseYjsRoomName(roomName: string): YjsRoomName | null {
  if (roomName.startsWith(YJS_DRAFT_ROOM_PREFIX)) {
    const draftId = roomName.slice(YJS_DRAFT_ROOM_PREFIX.length);
    return draftId.length > 0 ? { kind: "draft", draftId } : null;
  }
  return roomName.length > 0 ? { kind: "live", documentId: roomName as DocumentId } : null;
}
