/**
 * CRUD operations for proposals, queued ops, and document cache metadata.
 *
 * Headless and composable — no React dependencies. Operates against a
 * provided EditorDatabase instance so tests can use an isolated DB.
 */

import type {
  DocumentCacheMeta,
  EditorDatabase,
  PersistedProposal,
  ProposalStatus,
  QueuedProposalOp,
} from "./editor-db"

export class ProposalStore {
  constructor(private db: EditorDatabase) {}

  // -------------------------------------------------------------------------
  // Proposals
  // -------------------------------------------------------------------------

  async putProposal(proposal: PersistedProposal): Promise<void> {
    await this.db.proposals.put(proposal)
  }

  async getProposal(
    proposalId: string,
  ): Promise<PersistedProposal | undefined> {
    return this.db.proposals.get(proposalId)
  }

  async getProposalsByDocument(
    documentId: string,
  ): Promise<PersistedProposal[]> {
    return this.db.proposals.where("documentId").equals(documentId).toArray()
  }

  async getPendingProposals(
    documentId: string,
  ): Promise<PersistedProposal[]> {
    return this.db.proposals
      .where("[documentId+status]")
      .equals([documentId, "pending"])
      .toArray()
  }

  async updateProposalStatus(
    proposalId: string,
    status: ProposalStatus,
    acceptedAtOffset?: number | null,
  ): Promise<void> {
    const updates: Partial<PersistedProposal> = { status }
    if (acceptedAtOffset !== undefined) {
      updates.acceptedAtOffset = acceptedAtOffset
    }
    await this.db.proposals.update(proposalId, updates)
  }

  async deleteProposal(proposalId: string): Promise<void> {
    await this.db.proposals.delete(proposalId)
  }

  // -------------------------------------------------------------------------
  // Queued operations
  // -------------------------------------------------------------------------

  async enqueueOp(op: Omit<QueuedProposalOp, "id">): Promise<number> {
    return this.db.queuedOps.add(op as QueuedProposalOp)
  }

  async getQueuedOps(documentId: string): Promise<QueuedProposalOp[]> {
    return this.db.queuedOps.where("documentId").equals(documentId).toArray()
  }

  async dequeueOp(id: number): Promise<void> {
    await this.db.queuedOps.delete(id)
  }

  /**
   * Return all queued ops for a document and delete them atomically.
   * Used for server sync on reconnect.
   */
  async drainQueue(documentId: string): Promise<QueuedProposalOp[]> {
    return this.db.transaction("rw", this.db.queuedOps, async () => {
      const ops = await this.db.queuedOps
        .where("documentId")
        .equals(documentId)
        .toArray()
      const ids = ops.map((op) => op.id)
      await this.db.queuedOps.bulkDelete(ids)
      return ops
    })
  }

  // -------------------------------------------------------------------------
  // Document cache metadata
  // -------------------------------------------------------------------------

  /** Upsert lastAccessedAt to Date.now(). */
  async touchDocument(documentId: string): Promise<void> {
    await this.db.documentMeta.put({
      documentId,
      lastAccessedAt: Date.now(),
    })
  }

  async getDocumentMeta(
    documentId: string,
  ): Promise<DocumentCacheMeta | undefined> {
    return this.db.documentMeta.get(documentId)
  }

  /** Return documents not accessed within maxAgeMs (for periodic IDB cleanup). */
  async getColdDocuments(maxAgeMs: number): Promise<DocumentCacheMeta[]> {
    const cutoff = Date.now() - maxAgeMs
    return this.db.documentMeta
      .where("lastAccessedAt")
      .below(cutoff)
      .toArray()
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Clear all data for a document in a single transaction. */
  async clearDocument(documentId: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.proposals, this.db.queuedOps, this.db.documentMeta],
      async () => {
        await this.db.proposals
          .where("documentId")
          .equals(documentId)
          .delete()
        await this.db.queuedOps
          .where("documentId")
          .equals(documentId)
          .delete()
        await this.db.documentMeta.delete(documentId)
      },
    )
  }
}
