/** Application-defined WebSocket close contracts shared by clients and server transports. */

export const WS_CLOSE = {
  AUTH_FAILED: { code: 4401, reason: "auth_failed" },
  AUTH_ERROR: { code: 1011, reason: "auth_error" },
  PERMISSION_DENIED: { code: 4403, reason: "permission-denied" },
  DRAFT_STALE: { code: 4205, reason: "draft-stale-doc" },
  DRAFT_GENERATION_STALE: { code: 4206, reason: "draft-generation-stale" },
  /**
   * A draft update arrived before the update it depends on reached the draft's journal. Not a
   * refusal: the client reconnects and its next handshake's SyncStep2 carries the missing prefix.
   */
  DRAFT_PREFIX_MISSING: { code: 4207, reason: "draft-prefix-missing" },
  /** Terminal: the document was removed. Never reconnect. */
  DOCUMENT_DELETED: { code: 4208, reason: "document-deleted" },
  CLIENT_SCHEMA_SUPERSEDED: { code: 4406, reason: "client-schema-superseded" },
  DOCUMENT_SCHEMA_STALE: { code: 4407, reason: "document-schema-stale" },
  /**
   * The room's file access changed (a Work archived, unarchived, deleted or
   * restored). Not terminal: reconnect and take the new authenticated scope.
   */
  ACCESS_CHANGED: { code: 4409, reason: "access-changed" },
} as const;
