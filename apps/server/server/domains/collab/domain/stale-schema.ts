/** Major-version compatibility guard for persisted Yjs document heads. */
import {
  type CollabSchemaVersion,
  formatCollabSchemaVersion,
  serverServesHead,
} from "@meridian/prosemirror-schema";

export function isStaleSchema(
  storedVersion: CollabSchemaVersion | null | undefined,
  expectedVersion: CollabSchemaVersion,
): boolean {
  return storedVersion != null && !serverServesHead(storedVersion, expectedVersion);
}

export class DocumentSchemaMajorMismatchError extends Error {
  readonly docId: string;
  readonly storedVersion: CollabSchemaVersion;
  readonly expectedVersion: CollabSchemaVersion;

  constructor(
    docId: string,
    storedVersion: CollabSchemaVersion,
    expectedVersion: CollabSchemaVersion,
  ) {
    super(
      `Document ${docId} was persisted with schema version ${formatCollabSchemaVersion(storedVersion)} ` +
        `(current ${formatCollabSchemaVersion(expectedVersion)}); replay would corrupt CRDT state`,
    );
    this.name = "DocumentSchemaMajorMismatchError";
    this.docId = docId;
    this.storedVersion = storedVersion;
    this.expectedVersion = expectedVersion;
  }
}

export function isDocumentSchemaMajorMismatchError(
  cause: unknown,
): cause is DocumentSchemaMajorMismatchError {
  return cause instanceof DocumentSchemaMajorMismatchError;
}
