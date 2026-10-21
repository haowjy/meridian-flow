/**
 * Live-text fingerprints for the review list, without loading a room per item.
 *
 * A document's live state is its journal plus any room that holds unstored edits. With no
 * room open the state is a pure function of the journal, and every journal append
 * allocates the next admission on the document's authority head, a replacement bumps the
 * generation. So a fingerprint computed under (authority, generation, next admission) stays
 * exact until that head moves. A room that is open (or loading) may hold edits the head
 * hasn't seen, so it is always read under the coordinator lease.
 */
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { readHeadRevision } from "./drizzle-document-authority-head.js";

const MAX_ENTRIES = 512;

export function createLiveFingerprintReader(deps: {
  db: DrizzleDb;
  roomOpen(documentId: string): boolean;
  /** The full-state fingerprint read under the document's coordinator lease. */
  read(documentId: string): Promise<string>;
}): (documentId: string) => Promise<string> {
  const cache = new Map<string, { head: string; fingerprint: string }>();

  return async (documentId) => {
    if (deps.roomOpen(documentId)) {
      cache.delete(documentId);
      return deps.read(documentId);
    }
    // Read before the document: an append racing the read leaves a stale key, never a stale hit.
    const head = await readHeadRevision(deps.db, documentId);
    const hit = cache.get(documentId);
    if (hit?.head === head) return hit.fingerprint;
    const fingerprint = await deps.read(documentId);
    cache.delete(documentId);
    cache.set(documentId, { head, fingerprint });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    return fingerprint;
  };
}
