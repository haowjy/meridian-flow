import { JoinErrorCode, RoomErrorCode } from "loro-protocol";
import { z } from "zod";
import { CLOSED_OWNER_WHYS, type ClosedOwnerWhy } from "../commands/index.js";
import type { DocumentId, DraftId } from "../ids.js";

export const LORO_WS_PATH = "/ws/loro";

/**
 * Liveness for a room socket, outside the Loro protocol (a text frame): the server sends one every
 * interval, and a client that hears nothing for the timeout replaces the socket, since a
 * half-open connection never closes on its own and its unacknowledged batches are resent only by
 * a new Join.
 */
export const LORO_PING = "ping";
export const LORO_PING_INTERVAL_MS = 30_000;
export const LORO_PING_TIMEOUT_MS = 45_000;

export type TreeListRef =
  | { kind: "project"; projectId: string }
  | { kind: "account"; userId: string };

export type LoroRoom =
  | { kind: "live"; documentId: DocumentId }
  | { kind: "fork"; draftId: DraftId; documentId: DocumentId }
  | { kind: "tree"; list: TreeListRef };

export type DocumentRoom = Extract<LoroRoom, { kind: "live" | "fork" }>;

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

export function liveRoomOf(room: DocumentRoom): DocumentRoom {
  return { kind: "live", documentId: room.documentId };
}

export const SERVER_PEER_LIMIT = 1n << 48n;
export const PEER_ID_LIMIT = 1n << 64n;

export interface LoroJoinAuth {
  schema: string;
  peer: string;
  account: string;
}

const joinAuthSchema = z.object({
  v: z.literal(1),
  schema: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
  peer: z
    .string()
    .regex(/^\d{1,20}$/)
    .refine((peer) => BigInt(peer) >= SERVER_PEER_LIMIT && BigInt(peer) < PEER_ID_LIMIT),
  account: z.string().min(1),
});

export function encodeLoroJoinAuth(auth: LoroJoinAuth): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, ...auth }));
}

export function decodeLoroJoinAuth(bytes: Uint8Array): LoroJoinAuth | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const parsed = joinAuthSchema.safeParse(value);
  if (!parsed.success) return null;
  const { schema, peer, account } = parsed.data;
  return { schema, peer, account };
}

export const LORO_JOIN_ERROR = {
  BAD_AUTH: { code: JoinErrorCode.AuthFailed, appCode: "bad-auth", terminal: true },
  PERMISSION_DENIED: {
    code: JoinErrorCode.AuthFailed,
    appCode: "permission-denied",
    terminal: true,
  },
  ACCOUNT_CHANGED: { code: JoinErrorCode.AuthFailed, appCode: "account-changed", terminal: true },
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

export const LORO_ROOM_ERROR = {
  ACCESS_CHANGED: { code: RoomErrorCode.RejoinSuggested, reason: "access-changed" },
  DOCUMENT_DELETED: { code: RoomErrorCode.Evicted, reason: "document-deleted" },
  CORRUPT_UPDATE: { code: RoomErrorCode.Evicted, reason: "corrupt-update" },
  HISTORY_CUTOFF: { code: RoomErrorCode.Evicted, reason: "history-cutoff" },
  SERVER_ERROR: { code: RoomErrorCode.RejoinSuggested, reason: "server-error" },
} as const;

export function loroAccessChangedReason(why?: ClosedOwnerWhy): string {
  const { reason } = LORO_ROOM_ERROR.ACCESS_CHANGED;
  return why ? `${reason}:${why}` : reason;
}

export type LoroJoinExtra = { readOnlyWhy?: ClosedOwnerWhy; list?: string };

export function encodeLoroJoinExtra(extra: LoroJoinExtra): Uint8Array {
  const value = {
    ...(extra.readOnlyWhy ? { readOnlyWhy: extra.readOnlyWhy } : {}),
    ...(extra.list ? { list: extra.list } : {}),
  };
  return Object.keys(value).length > 0
    ? new TextEncoder().encode(JSON.stringify(value))
    : new Uint8Array();
}

const joinExtraSchema = z.object({
  readOnlyWhy: z.enum(CLOSED_OWNER_WHYS).optional(),
  list: z.string().optional(),
});

export function decodeLoroJoinExtra(bytes: Uint8Array | undefined): LoroJoinExtra {
  if (!bytes || bytes.byteLength === 0) return {};
  try {
    const parsed = joinExtraSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) return {};
    return {
      ...(parsed.data.readOnlyWhy ? { readOnlyWhy: parsed.data.readOnlyWhy } : {}),
      ...(parsed.data.list ? { list: parsed.data.list } : {}),
    };
  } catch {
    return {};
  }
}

export function loroRoomErrorOf(message: string) {
  return Object.values(LORO_ROOM_ERROR).find(
    (entry) => message === entry.reason || message.startsWith(`${entry.reason}:`),
  );
}
