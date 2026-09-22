/**
 * Account-global recently opened documents: list plus fire-and-forget record.
 */
import {
  apiAccountRecentDocumentsPath,
  type ListRecentDocumentsResponse,
  type RecentDocumentItem,
} from "@meridian/contracts/protocol";

import { getJson, HttpResponseError, postJson } from "./http-client";

/** Skip a repeat open of the same document within this window. */
const RECORD_THROTTLE_MS = 5_000;
/**
 * A freshly created document's row lands after its open, so the first write can
 * miss with a 404. Retry only that miss, with backoff.
 */
const RECORD_RETRY_MS = [1_500, 3_000, 6_000];
const lastRecordedAt = new Map<string, number>();
const inFlight = new Set<string>();

export async function listRecentDocuments(): Promise<RecentDocumentItem[]> {
  const response = await getJson<ListRecentDocumentsResponse>(apiAccountRecentDocumentsPath());
  return response.documents;
}

/**
 * Record that the writer opened a document. Resolves `true` once the server has
 * the row, `false` when it was throttled, skipped, or gave up. Callers use the
 * result to refresh the list; the open itself never waits on this.
 */
export async function recordRecentDocument(
  documentId: string,
  accountId?: string,
): Promise<boolean> {
  const key = accountId ? `${accountId}:${documentId}` : documentId;
  if (inFlight.has(key)) return false;
  if (Date.now() - (lastRecordedAt.get(key) ?? 0) < RECORD_THROTTLE_MS) return false;
  inFlight.add(key);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await postJson(apiAccountRecentDocumentsPath(), { documentId });
        lastRecordedAt.set(key, Date.now());
        return true;
      } catch (error) {
        const delay = RECORD_RETRY_MS[attempt];
        // Only a missing row is worth retrying; anything else is a real fault.
        if (!(error instanceof HttpResponseError) || error.status !== 404 || delay === undefined) {
          return false;
        }
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
    }
  } finally {
    inFlight.delete(key);
  }
}
