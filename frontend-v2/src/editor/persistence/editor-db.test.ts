import "fake-indexeddb/auto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { EditorDatabase, type PersistedProposal } from "./editor-db"
import { ProposalStore } from "./proposal-store"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposal(
  overrides: Partial<PersistedProposal> = {},
): PersistedProposal {
  return {
    proposalId: "p-1",
    documentId: "doc-1",
    yjsUpdate: new Uint8Array([1, 2, 3]),
    status: "pending",
    createdAt: 1000,
    createdByUserId: "user-1",
    regionTextBefore: "old text",
    regionTextAfter: "new text",
    proposedAtOffset: 0,
    acceptedAtOffset: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("EditorDatabase + ProposalStore", () => {
  let db: EditorDatabase
  let store: ProposalStore

  beforeEach(() => {
    // Unique name per test to avoid cross-test interference in fake-indexeddb
    db = new EditorDatabase(`test-${Math.random().toString(36).slice(2)}`)
    store = new ProposalStore(db)
  })

  afterEach(async () => {
    await db.delete()
  })

  // -----------------------------------------------------------------------
  // Proposals: insert, update, query
  // -----------------------------------------------------------------------

  describe("proposals", () => {
    it("inserts and retrieves a proposal by ID", async () => {
      const proposal = makeProposal()
      await store.putProposal(proposal)

      const retrieved = await store.getProposal("p-1")
      expect(retrieved).toBeDefined()
      expect(retrieved!.proposalId).toBe("p-1")
      expect(retrieved!.documentId).toBe("doc-1")
      expect(retrieved!.status).toBe("pending")
      expect(retrieved!.regionTextBefore).toBe("old text")
      expect(retrieved!.regionTextAfter).toBe("new text")
    })

    it("returns undefined for non-existent proposal", async () => {
      const result = await store.getProposal("nope")
      expect(result).toBeUndefined()
    })

    it("queries proposals by documentId", async () => {
      await store.putProposal(makeProposal({ proposalId: "p-1", documentId: "doc-1" }))
      await store.putProposal(makeProposal({ proposalId: "p-2", documentId: "doc-1" }))
      await store.putProposal(makeProposal({ proposalId: "p-3", documentId: "doc-2" }))

      const doc1Proposals = await store.getProposalsByDocument("doc-1")
      expect(doc1Proposals).toHaveLength(2)
      expect(doc1Proposals.map((p) => p.proposalId).sort()).toEqual(["p-1", "p-2"])

      const doc2Proposals = await store.getProposalsByDocument("doc-2")
      expect(doc2Proposals).toHaveLength(1)
    })

    it("getPendingProposals returns only pending status", async () => {
      await store.putProposal(
        makeProposal({ proposalId: "p-1", status: "pending" }),
      )
      await store.putProposal(
        makeProposal({ proposalId: "p-2", status: "accepted" }),
      )
      await store.putProposal(
        makeProposal({ proposalId: "p-3", status: "rejected" }),
      )
      await store.putProposal(
        makeProposal({ proposalId: "p-4", status: "stale" }),
      )
      await store.putProposal(
        makeProposal({ proposalId: "p-5", status: "pending" }),
      )

      const pending = await store.getPendingProposals("doc-1")
      expect(pending).toHaveLength(2)
      expect(pending.map((p) => p.proposalId).sort()).toEqual(["p-1", "p-5"])
    })

    it("updateProposalStatus changes status", async () => {
      await store.putProposal(makeProposal())
      await store.updateProposalStatus("p-1", "accepted")

      const updated = await store.getProposal("p-1")
      expect(updated!.status).toBe("accepted")
    })

    it("updateProposalStatus records acceptedAtOffset", async () => {
      await store.putProposal(makeProposal())
      await store.updateProposalStatus("p-1", "accepted", 42)

      const updated = await store.getProposal("p-1")
      expect(updated!.status).toBe("accepted")
      expect(updated!.acceptedAtOffset).toBe(42)
    })

    it("deletes a proposal", async () => {
      await store.putProposal(makeProposal())
      await store.deleteProposal("p-1")

      const result = await store.getProposal("p-1")
      expect(result).toBeUndefined()
    })

    it("putProposal upserts on same proposalId", async () => {
      await store.putProposal(makeProposal({ status: "pending" }))
      await store.putProposal(makeProposal({ status: "accepted" }))

      const proposals = await store.getProposalsByDocument("doc-1")
      expect(proposals).toHaveLength(1)
      expect(proposals[0].status).toBe("accepted")
    })

    it("persists yjsUpdate as binary data", async () => {
      const update = new Uint8Array([10, 20, 30, 40])
      await store.putProposal(makeProposal({ yjsUpdate: update }))

      const retrieved = await store.getProposal("p-1")
      // fake-indexeddb may return a different Uint8Array realm instance,
      // so check contents rather than instanceof
      expect(Array.from(new Uint8Array(retrieved!.yjsUpdate))).toEqual([
        10, 20, 30, 40,
      ])
    })
  })

  // -----------------------------------------------------------------------
  // Queued operations
  // -----------------------------------------------------------------------

  describe("queued operations", () => {
    it("enqueues and retrieves ops for a document", async () => {
      const id = await store.enqueueOp({
        documentId: "doc-1",
        proposalId: "p-1",
        operation: "accept",
        enqueuedAt: 1000,
      })

      expect(id).toBeTruthy()

      const ops = await store.getQueuedOps("doc-1")
      expect(ops).toHaveLength(1)
      expect(ops[0].operation).toBe("accept")
      expect(ops[0].proposalId).toBe("p-1")
    })

    it("dequeues a single op", async () => {
      const id = await store.enqueueOp({
        documentId: "doc-1",
        proposalId: "p-1",
        operation: "accept",
        enqueuedAt: 1000,
      })

      await store.dequeueOp(id)

      const ops = await store.getQueuedOps("doc-1")
      expect(ops).toHaveLength(0)
    })

    it("drainQueue returns all ops and deletes them atomically", async () => {
      await store.enqueueOp({
        documentId: "doc-1",
        proposalId: "p-1",
        operation: "accept",
        enqueuedAt: 1000,
      })
      await store.enqueueOp({
        documentId: "doc-1",
        proposalId: "p-2",
        operation: "reject",
        enqueuedAt: 2000,
      })
      // Different document — should not be drained
      await store.enqueueOp({
        documentId: "doc-2",
        proposalId: "p-3",
        operation: "accept",
        enqueuedAt: 3000,
      })

      const drained = await store.drainQueue("doc-1")
      expect(drained).toHaveLength(2)
      expect(drained.map((op) => op.proposalId).sort()).toEqual(["p-1", "p-2"])

      // Queue for doc-1 is now empty
      const remaining = await store.getQueuedOps("doc-1")
      expect(remaining).toHaveLength(0)

      // doc-2 ops are untouched
      const doc2Ops = await store.getQueuedOps("doc-2")
      expect(doc2Ops).toHaveLength(1)
    })

    it("drainQueue returns empty array when no ops", async () => {
      const drained = await store.drainQueue("doc-1")
      expect(drained).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // Document cache metadata
  // -----------------------------------------------------------------------

  describe("document cache metadata", () => {
    it("touchDocument creates metadata entry", async () => {
      const before = Date.now()
      await store.touchDocument("doc-1")
      const after = Date.now()

      const meta = await store.getDocumentMeta("doc-1")
      expect(meta).toBeDefined()
      expect(meta!.documentId).toBe("doc-1")
      expect(meta!.lastAccessedAt).toBeGreaterThanOrEqual(before)
      expect(meta!.lastAccessedAt).toBeLessThanOrEqual(after)
    })

    it("touchDocument upserts lastAccessedAt", async () => {
      // First touch
      vi.spyOn(Date, "now").mockReturnValue(1000)
      await store.touchDocument("doc-1")

      let meta = await store.getDocumentMeta("doc-1")
      expect(meta!.lastAccessedAt).toBe(1000)

      // Second touch — later timestamp
      vi.spyOn(Date, "now").mockReturnValue(5000)
      await store.touchDocument("doc-1")

      meta = await store.getDocumentMeta("doc-1")
      expect(meta!.lastAccessedAt).toBe(5000)

      vi.restoreAllMocks()
    })

    it("getDocumentMeta returns undefined for unknown doc", async () => {
      const meta = await store.getDocumentMeta("nope")
      expect(meta).toBeUndefined()
    })

    it("getColdDocuments returns documents older than maxAgeMs", async () => {
      const now = 100_000
      vi.spyOn(Date, "now").mockReturnValue(now)

      // doc-1: accessed 60s ago (cold if maxAge = 30s)
      await db.documentMeta.put({ documentId: "doc-1", lastAccessedAt: now - 60_000 })
      // doc-2: accessed 10s ago (warm if maxAge = 30s)
      await db.documentMeta.put({ documentId: "doc-2", lastAccessedAt: now - 10_000 })
      // doc-3: accessed 45s ago (cold if maxAge = 30s)
      await db.documentMeta.put({ documentId: "doc-3", lastAccessedAt: now - 45_000 })

      const cold = await store.getColdDocuments(30_000)
      expect(cold).toHaveLength(2)
      expect(cold.map((d) => d.documentId).sort()).toEqual(["doc-1", "doc-3"])

      vi.restoreAllMocks()
    })

    it("getColdDocuments returns empty when all documents are recent", async () => {
      vi.spyOn(Date, "now").mockReturnValue(100_000)

      await db.documentMeta.put({ documentId: "doc-1", lastAccessedAt: 99_000 })

      const cold = await store.getColdDocuments(30_000)
      expect(cold).toHaveLength(0)

      vi.restoreAllMocks()
    })
  })

  // -----------------------------------------------------------------------
  // clearDocument
  // -----------------------------------------------------------------------

  describe("clearDocument", () => {
    it("removes proposals, queued ops, and document meta for a document", async () => {
      // Set up data for doc-1
      await store.putProposal(makeProposal({ proposalId: "p-1", documentId: "doc-1" }))
      await store.putProposal(makeProposal({ proposalId: "p-2", documentId: "doc-1" }))
      await store.enqueueOp({
        documentId: "doc-1",
        proposalId: "p-1",
        operation: "accept",
        enqueuedAt: 1000,
      })
      await store.touchDocument("doc-1")

      // Set up data for doc-2 (should survive)
      await store.putProposal(makeProposal({ proposalId: "p-3", documentId: "doc-2" }))
      await store.enqueueOp({
        documentId: "doc-2",
        proposalId: "p-3",
        operation: "reject",
        enqueuedAt: 2000,
      })
      await store.touchDocument("doc-2")

      // Clear doc-1
      await store.clearDocument("doc-1")

      // doc-1 data is gone
      expect(await store.getProposalsByDocument("doc-1")).toHaveLength(0)
      expect(await store.getQueuedOps("doc-1")).toHaveLength(0)
      expect(await store.getDocumentMeta("doc-1")).toBeUndefined()

      // doc-2 data is untouched
      expect(await store.getProposalsByDocument("doc-2")).toHaveLength(1)
      expect(await store.getQueuedOps("doc-2")).toHaveLength(1)
      expect(await store.getDocumentMeta("doc-2")).toBeDefined()
    })

    it("clearDocument is safe on empty data", async () => {
      // Should not throw when there is nothing to clear
      await store.clearDocument("nonexistent")
    })
  })
})
