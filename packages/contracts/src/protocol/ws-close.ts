/** Application-defined WebSocket close contracts shared by clients and server transports. */

export const WS_CLOSE = {
  AUTH_FAILED: { code: 4401, reason: "auth_failed" },
  AUTH_ERROR: { code: 1011, reason: "auth_error" },
  PERMISSION_DENIED: { code: 4403, reason: "permission-denied" },
  /** Terminal: this draft ended. The transport reason names its close cause. */
  DRAFT_CLOSED: { code: 4205, reason: "discarded" },
  /**
   * A draft update arrived before the update it depends on reached the draft's journal. Not a
   * refusal: the client reconnects and its next handshake's SyncStep2 carries the missing prefix.
   */
  DRAFT_PREFIX_MISSING: { code: 4207, reason: "draft-prefix-missing" },
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
   * restored). Not terminal: reconnect and take the new authenticated scope.
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
