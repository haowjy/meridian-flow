/** Application-defined WebSocket close contracts shared by clients and server transports. */

export const WS_CLOSE = {
  AUTH_FAILED: { code: 4401, reason: "auth_failed" },
  AUTH_ERROR: { code: 1011, reason: "auth_error" },
  PERMISSION_DENIED: { code: 4403, reason: "permission-denied" },
  BRANCH_STALE: { code: 4205, reason: "branch-stale-doc" },
  CLIENT_SCHEMA_SUPERSEDED: { code: 4406, reason: "client-schema-superseded" },
  DOCUMENT_SCHEMA_STALE: { code: 4407, reason: "document-schema-stale" },
  /**
   * The room's file access changed (a Work archived, unarchived, deleted or
   * restored). Not terminal: reconnect and take the new authenticated scope.
   */
  ACCESS_CHANGED: { code: 4409, reason: "access-changed" },
} as const;
