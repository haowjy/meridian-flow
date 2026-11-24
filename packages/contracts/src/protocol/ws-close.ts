/** Application-defined WebSocket close contracts shared by clients and server transports. */

export const WS_CLOSE = {
  AUTH_FAILED: { code: 4401, reason: "auth_failed" },
  AUTH_ERROR: { code: 1011, reason: "auth_error" },
  PERMISSION_DENIED: { code: 4403, reason: "permission-denied" },
  /** Terminal: the document was removed. Never reconnect. */
  DOCUMENT_DELETED: { code: 4208, reason: "document-deleted" },
  CLIENT_SCHEMA_SUPERSEDED: { code: 4406, reason: "client-schema-superseded" },
  DOCUMENT_SCHEMA_STALE: { code: 4407, reason: "document-schema-stale" },
  /** The server is stopping (a deploy): reconnect, and the Join exchange resends what is unsaved. */
  SERVER_SHUTDOWN: { code: 1012, reason: "server-shutdown" },
} as const;
