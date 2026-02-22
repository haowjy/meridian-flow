import { db } from "@/core/lib/db";
import { makeLogger } from "@/core/lib/logger";

const log = makeLogger("proposal-cache");

/**
 * Cache a proposal's yjsUpdate in IndexedDB for instant re-open.
 * Fire-and-forget — callers should not await this.
 */
export async function cacheProposalUpdate(
  proposalId: string,
  documentId: string,
  yjsUpdate: string,
): Promise<void> {
  try {
    await db.proposalUpdates.put({
      proposalId,
      documentId,
      yjsUpdate,
      cachedAt: new Date().toISOString(),
    });
  } catch (err) {
    log.warn("failed to cache proposal update", {
      proposalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Load all cached yjsUpdate values for a document.
 * Returns a Map<proposalId, yjsUpdate (base64)>.
 */
export async function getCachedUpdatesForDocument(
  documentId: string,
): Promise<Map<string, string>> {
  try {
    const entries = await db.proposalUpdates
      .where("documentId")
      .equals(documentId)
      .toArray();
    const result = new Map<string, string>();
    for (const entry of entries) {
      result.set(entry.proposalId, entry.yjsUpdate);
    }
    return result;
  } catch (err) {
    log.warn("failed to load cached proposal updates", {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

/**
 * Delete a single cached proposal update (e.g. after accept/reject).
 * Fire-and-forget.
 */
export async function deleteCachedProposalUpdate(
  proposalId: string,
): Promise<void> {
  try {
    await db.proposalUpdates.delete(proposalId);
  } catch (err) {
    log.warn("failed to delete cached proposal update", {
      proposalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Remove cached entries for proposals no longer in the active set.
 * Fire-and-forget.
 */
export async function pruneStaleProposalUpdates(
  documentId: string,
  activeProposalIds: Set<string>,
): Promise<void> {
  try {
    const entries = await db.proposalUpdates
      .where("documentId")
      .equals(documentId)
      .toArray();
    const staleIds = entries
      .filter((e) => !activeProposalIds.has(e.proposalId))
      .map((e) => e.proposalId);
    if (staleIds.length > 0) {
      await db.proposalUpdates.bulkDelete(staleIds);
    }
  } catch (err) {
    log.warn("failed to prune stale proposal updates", {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
