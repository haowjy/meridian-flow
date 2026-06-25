// Deployment-owned document creation seam for agent-edit coordinators.

/**
 * Brings a document into existence so the coordinator can grant access to it.
 * Implemented per deployment (server: create the journal head + register the
 * live doc with Hocuspocus; in-memory: instantiate an empty Y.Doc entry).
 */
export interface DocumentLifecycle {
  /**
   * Ensure a live document exists for docId. Idempotent: create when missing,
   * no-op when present. After this resolves, coordinator.withDocument(docId)
   * must succeed. Must NOT clobber an existing document's content.
   */
  ensureDocument(docId: string): Promise<void>;
}
