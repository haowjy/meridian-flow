/**
 * Purpose: Defines the Yjs WebSocket path and room-name wire contract shared by collaborative sync clients and server handlers.
 * Why independent: Path constants and room names are protocol primitives shared across the frontend editor and server WebSocket adapter.
 */
import type { DocumentId } from "../runtime/index.js";

export const YJS_WS_PATH_PREFIX = "/ws/yjs";
export const YJS_DRAFT_ROOM_PREFIX = "draft:";
export const YJS_BRANCH_ROOM_PREFIX = "branch:";
const BRANCH_GENERATION_SEPARATOR = ":gen:";

export type YjsRoomName =
  | { kind: "live"; documentId: DocumentId }
  | { kind: "draft"; draftId: string }
  | { kind: "branch"; branchId: string; generation: number };

export function yjsWsPath(): string {
  return YJS_WS_PATH_PREFIX;
}

export function draftRoomName(draftId: string): string {
  return `${YJS_DRAFT_ROOM_PREFIX}${draftId}`;
}

export function branchRoomName(branchId: string, generation?: number): string {
  return generation === undefined
    ? `${YJS_BRANCH_ROOM_PREFIX}${branchId}`
    : `${YJS_BRANCH_ROOM_PREFIX}${branchId}${BRANCH_GENERATION_SEPARATOR}${generation}`;
}

export function parseYjsRoomName(roomName: string): YjsRoomName | null {
  if (roomName.startsWith(YJS_DRAFT_ROOM_PREFIX)) {
    const draftId = roomName.slice(YJS_DRAFT_ROOM_PREFIX.length);
    return draftId.length > 0 ? { kind: "draft", draftId } : null;
  }
  if (roomName.startsWith(YJS_BRANCH_ROOM_PREFIX)) {
    const raw = roomName.slice(YJS_BRANCH_ROOM_PREFIX.length);
    const separatorIndex = raw.lastIndexOf(BRANCH_GENERATION_SEPARATOR);
    if (separatorIndex <= 0) return null;
    const branchId = raw.slice(0, separatorIndex);
    const generation = Number.parseInt(
      raw.slice(separatorIndex + BRANCH_GENERATION_SEPARATOR.length),
      10,
    );
    return branchId.length > 0 && Number.isSafeInteger(generation) && generation > 0
      ? { kind: "branch", branchId, generation }
      : null;
  }
  return roomName.length > 0 ? { kind: "live", documentId: roomName as DocumentId } : null;
}
