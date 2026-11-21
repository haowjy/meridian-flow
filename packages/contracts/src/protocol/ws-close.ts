/** Application-defined WebSocket close contracts shared by clients and server transports. */

import { CLOSED_OWNER_WHYS, type ClosedOwnerWhy } from "../commands/index.js";

export const WS_CLOSE = {
  AUTH_FAILED: { code: 4401, reason: "auth_failed" },
  AUTH_ERROR: { code: 1011, reason: "auth_error" },
  PERMISSION_DENIED: { code: 4403, reason: "permission-denied" },
  /**
   * The server could not store a writer's frame on a document room. Not terminal:
   * the client reconnects and its handshake resends. A client counts these, since a frame the
   * server can never store would otherwise loop.
   */
  WRITER_ADMISSION_FAILED: { code: 1013, reason: "writer-journal-admission-failed" },
  /**
   * The server has no such document yet: a browser makes a document's id and connects its text
   * room as soon as it appends the `create`, which the server may not have admitted yet. Not
   * terminal: the provider reconnects until the create is admitted.
   */
  DOCUMENT_UNKNOWN: { code: 4211, reason: "document-unknown" },
  /** Terminal: the document was removed. Never reconnect. */
  DOCUMENT_DELETED: { code: 4208, reason: "document-deleted" },
  /**
   * Terminal: a tree list's room found this client's copy does something an honest client's
   * never does (a deletion, a struct that can't be placed, a server-only kind). Never reconnect:
   * the same bytes would be sent again. The client keeps the broken copy and loads a fresh one.
   */
  COPY_BROKEN: { code: 4212, reason: "copy-broken" },
  /**
   * The stored copy is of another list than the one the room serves (a reset database, a
   * recreated account list): the reason is `list-changed:<list id>`. The client loads from
   * nothing and connects again; it carries nothing, for its records name nodes of a list that is
   * gone.
   */
  LIST_CHANGED: { code: 4213, reason: "list-changed" },
  CLIENT_SCHEMA_SUPERSEDED: { code: 4406, reason: "client-schema-superseded" },
  DOCUMENT_SCHEMA_STALE: { code: 4407, reason: "document-schema-stale" },
  /**
   * The room's file access changed (a Work archived, unarchived, deleted or
   * restored). Not terminal: reconnect and take the new authenticated scope. A close
   * because a Work or chat closed names it: `access-changed:<ClosedOwnerWhy>`.
   */
  ACCESS_CHANGED: { code: 4409, reason: "access-changed" },
} as const;

/** The close that sends a client of another list's copy to load the real list from nothing. */
export function listChangedClose(listId: string) {
  const { code, reason } = WS_CLOSE.LIST_CHANGED;
  return { code, reason: `${reason}:${listId}` };
}

/** The list id a list-changed close names, if it is one. */
export function listChangedId(event: { code: number; reason: string }): string | undefined {
  const { code, reason } = WS_CLOSE.LIST_CHANGED;
  return event.code === code && event.reason.startsWith(`${reason}:`)
    ? event.reason.slice(reason.length + 1)
    : undefined;
}

/** The 4409 close; `why` names a closed owner, and is left out for any other change of access. */
export function accessChangedClose(why?: ClosedOwnerWhy) {
  const { code, reason } = WS_CLOSE.ACCESS_CHANGED;
  return { code, reason: why ? `${reason}:${why}` : reason };
}

/** Whether this close is a 4409, with or without a reason. */
export function isAccessChangedClose(event: { code?: number; reason: string }): boolean {
  const { code, reason } = WS_CLOSE.ACCESS_CHANGED;
  return event.code === code || event.reason === reason || event.reason.startsWith(`${reason}:`);
}

/** The closed owner a 4409 names, if it names one. */
export function accessChangedWhy(event: {
  code?: number;
  reason: string;
}): ClosedOwnerWhy | undefined {
  if (!isAccessChangedClose(event)) return undefined;
  const why = event.reason.slice(WS_CLOSE.ACCESS_CHANGED.reason.length + 1);
  return CLOSED_OWNER_WHYS.find((known) => known === why);
}
