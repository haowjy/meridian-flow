/**
 * The Loro room protocol's application half (design §4): the socket path, room names, the Join
 * auth payload and the per-room refusals. Frames are `loro-protocol`'s; the update and version
 * bytes they carry are `@meridian/document-model` envelopes, which the protocol never decodes.
 *
 * One socket carries several rooms (a Draft tab joins a document's Live room, then its fork room),
 * so a refusal for one room is a frame for that room, not a socket close: a `JoinError` at Join,
 * a `RoomError` after. The socket itself still closes with `WS_CLOSE` for sign-in failures.
 */

import { JoinErrorCode, RoomErrorCode } from "loro-protocol";
import { z } from "zod";
import type { DocumentId, DraftId } from "../ids.js";

export const LORO_WS_PATH = "/ws/loro";

/** A tree list is one project's or one account's (`user://`). */
export type TreeListRef =
  | { kind: "project"; projectId: string }
  | { kind: "account"; userId: string };

/**
 * A Loro room. `live` and `fork` rooms hold a document's docs (a structure doc and a text doc per
 * block); a `tree` room holds one project's or account's tree list.
 */
export type LoroRoom =
  | { kind: "live"; documentId: DocumentId }
  | { kind: "fork"; draftId: DraftId; documentId: DocumentId }
  | { kind: "tree"; list: TreeListRef };

/** The rooms that hold a document. */
export type DocumentRoom = Extract<LoroRoom, { kind: "live" | "fork" }>;

/** `live:<doc>`, `fork:<draft>:<doc>`, `tree:project:<id>`, `tree:account:<id>`. */
export function loroRoomName(room: LoroRoom): string {
  switch (room.kind) {
    case "live":
      return `live:${room.documentId}`;
    case "fork":
      return `fork:${room.draftId}:${room.documentId}`;
    case "tree":
      return room.list.kind === "project"
        ? `tree:project:${room.list.projectId}`
        : `tree:account:${room.list.userId}`;
  }
}

export function parseLoroRoomName(name: string): LoroRoom | null {
  const [kind, ...parts] = name.split(":");
  if (parts.some((part) => part.length === 0)) return null;
  if (kind === "live" && parts.length === 1) return { kind: "live", documentId: parts[0] };
  if (kind === "fork" && parts.length === 2)
    return { kind: "fork", draftId: parts[0], documentId: parts[1] };
  if (kind === "tree" && parts.length === 2) {
    if (parts[0] === "project")
      return { kind: "tree", list: { kind: "project", projectId: parts[1] } };
    if (parts[0] === "account")
      return { kind: "tree", list: { kind: "account", userId: parts[1] } };
  }
  return null;
}

/** A fork's Live room: the one it forwards from, which a tab joins first. */
export function liveRoomOf(room: DocumentRoom): DocumentRoom {
  return { kind: "live", documentId: room.documentId };
}

/**
 * Peer ids below this are the server's own writers; a client's are at or above it, up to 2^64
 * (design §4). A reader tells the server's ops from a client's by the id alone.
 */
export const SERVER_PEER_LIMIT = 1n << 48n;
export const PEER_ID_LIMIT = 1n << 64n;

/**
 * `JoinRequest.auth`: what the server needs to admit this copy to the room beyond the socket's
 * session (the sign-in cookie authenticates the socket once, at upgrade). `schema` is the
 * client's collab schema version (`major.minor.patch`), checked against the document's; `peer`
 * is the Loro peer id this copy writes under in this room: a u64 as a decimal string, in the
 * client range (`SERVER_PEER_LIMIT` and up), so a client's ops never read as the server's.
 */
export interface LoroJoinAuth {
  schema: string;
  peer: string;
}

const joinAuthSchema = z.object({
  v: z.literal(1),
  schema: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
  peer: z
    .string()
    .regex(/^\d{1,20}$/)
    .refine((peer) => BigInt(peer) >= SERVER_PEER_LIMIT && BigInt(peer) < PEER_ID_LIMIT),
});

export function encodeLoroJoinAuth(auth: LoroJoinAuth): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, ...auth }));
}

/**
 * Null for a payload that is not one, or whose peer is outside the client range: the server
 * answers with `LORO_JOIN_ERROR.BAD_AUTH`. Join is where the server may refuse; a frame's content
 * never is.
 */
export function decodeLoroJoinAuth(bytes: Uint8Array): LoroJoinAuth | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const parsed = joinAuthSchema.safeParse(value);
  return parsed.success ? { schema: parsed.data.schema, peer: parsed.data.peer } : null;
}

/**
 * Refusals at Join, sent as `JoinError` with the `appCode`. `terminal` says whether the client
 * stops trying to join the room; the others rejoin when the cause can have changed.
 */
export const LORO_JOIN_ERROR = {
  BAD_AUTH: { code: JoinErrorCode.AuthFailed, appCode: "bad-auth", terminal: true },
  PERMISSION_DENIED: {
    code: JoinErrorCode.AuthFailed,
    appCode: "permission-denied",
    terminal: true,
  },
  /** A browser connects a document it just made before the server has its `create`. */
  DOCUMENT_UNKNOWN: { code: JoinErrorCode.AppError, appCode: "document-unknown", terminal: false },
  DOCUMENT_DELETED: { code: JoinErrorCode.AppError, appCode: "document-deleted", terminal: true },
  CLIENT_SCHEMA_SUPERSEDED: {
    code: JoinErrorCode.AppError,
    appCode: "client-schema-superseded",
    terminal: true,
  },
  DOCUMENT_SCHEMA_STALE: {
    code: JoinErrorCode.AppError,
    appCode: "document-schema-stale",
    terminal: true,
  },
} as const;

/**
 * Ends of a joined room, sent as `RoomError` with the reason as its message. The protocol's
 * `RejoinSuggested` rejoins; `Evicted` does not. The server never refuses a frame for what it
 * says: a frame is acked once imported, pending or not, and only these end a room.
 */
export const LORO_ROOM_ERROR = {
  /**
   * The room's file access changed (a Work archived, a move to another source, a create landing in
   * Live, a project deletion): rejoin at the new access. A close for a closed owner names it,
   * `access-changed:<ClosedOwnerWhy>`, as the 4409 socket close does.
   */
  ACCESS_CHANGED: { code: RoomErrorCode.RejoinSuggested, reason: "access-changed" },
  DOCUMENT_DELETED: { code: RoomErrorCode.Evicted, reason: "document-deleted" },
  /** Bytes that do not decode or fail Loro's checksum. The client keeps its copy and loads fresh. */
  CORRUPT_UPDATE: { code: RoomErrorCode.Evicted, reason: "corrupt-update" },
  /**
   * The client's update depends on history below the room's shallow cutoff (a tab offline past
   * the 7-day cutoff). Its typing cannot land; the tab shows "Couldn't save".
   */
  HISTORY_CUTOFF: { code: RoomErrorCode.Evicted, reason: "history-cutoff" },
} as const;

export type LoroRoomErrorReason = (typeof LORO_ROOM_ERROR)[keyof typeof LORO_ROOM_ERROR]["reason"];

/** The `LORO_ROOM_ERROR` entry a `RoomError` message names, if any. */
export function loroRoomErrorOf(message: string) {
  return Object.values(LORO_ROOM_ERROR).find(
    (entry) => message === entry.reason || message.startsWith(`${entry.reason}:`),
  );
}
