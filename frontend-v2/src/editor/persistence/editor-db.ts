/**
 * Dexie database for editor application state.
 *
 * Complements y-indexeddb (which holds Y.Doc binary state). This store
 * persists AI proposals, queued accept/reject operations, and document
 * cache metadata so the editor works offline and survives page reloads.
 *
 * Single database instance — not per-document. Schema versioning lives
 * here so later phases don't fork types.
 */

import Dexie, { type Table } from "dexie"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale"

export interface PersistedProposal {
  proposalId: string
  documentId: string
  yjsUpdate: Uint8Array // the Yjs binary update
  status: ProposalStatus
  createdAt: number
  createdByUserId: string
  regionTextBefore: string // canonical text in affected region before proposal
  regionTextAfter: string // projected text after applying this proposal
  proposedAtOffset: number // character offset when proposal was created
  acceptedAtOffset: number | null // character offset when accepted (null if pending)
}

export interface QueuedProposalOp {
  id: number // auto-incremented by Dexie (++id)
  documentId: string
  proposalId: string
  operation: "accept" | "reject"
  enqueuedAt: number
}

export interface DocumentCacheMeta {
  documentId: string
  lastAccessedAt: number
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export class EditorDatabase extends Dexie {
  proposals!: Table<PersistedProposal, string>
  queuedOps!: Table<QueuedProposalOp, number>
  documentMeta!: Table<DocumentCacheMeta, string>

  constructor(name = "meridian-editor") {
    super(name)

    this.version(1).stores({
      // Primary key + secondary indexes
      proposals: "proposalId, documentId, [documentId+status]",
      queuedOps: "++id, documentId, proposalId",
      documentMeta: "documentId, lastAccessedAt",
    })
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Default shared database instance. Tests can create isolated instances. */
export const editorDb = new EditorDatabase()
