/** Stale ProseMirror schema detection for persisted Yjs document heads. */

export function isStaleSchema(
  storedVersion: number | null | undefined,
  expectedVersion: number,
): boolean {
  return storedVersion != null && storedVersion < expectedVersion;
}

export class StaleDocumentSchemaError extends Error {
  readonly docId: string;
  readonly storedVersion: number;
  readonly expectedVersion: number;

  constructor(docId: string, storedVersion: number, expectedVersion: number) {
    super(
      `Document ${docId} was persisted with schema version ${storedVersion} ` +
        `(current ${expectedVersion}); replay would corrupt CRDT state`,
    );
    this.name = "StaleDocumentSchemaError";
    this.docId = docId;
    this.storedVersion = storedVersion;
    this.expectedVersion = expectedVersion;
  }
}

export function isStaleDocumentSchemaError(cause: unknown): cause is StaleDocumentSchemaError {
  return cause instanceof StaleDocumentSchemaError;
}
