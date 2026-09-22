/**
 * Account-global recently opened documents: list plus fire-and-forget record.
 */
import {
  apiAccountRecentDocumentsPath,
  type ListRecentDocumentsResponse,
  type RecentDocumentItem,
  type RecordRecentDocumentResponse,
} from "@meridian/contracts/protocol";

import { getJson, HttpResponseError, postJson } from "./http-client";

/**
 * The client mints a document id when it reserves a resource, and the server
 * writes the row when that reservation materializes. Opening the document
 * between those two moments is normal, so the first write 404s and a retry is
 * what lands the row. Measured, not assumed: opening a just-created file POSTs
 * a 404 and, without this, the document never appears in recents.
 */
const RECORD_RETRY_MS = [1_500, 3_000, 6_000];

export async function listRecentDocuments(): Promise<RecentDocumentItem[]> {
  const response = await getJson<ListRecentDocumentsResponse>(apiAccountRecentDocumentsPath());
  return response.documents;
}

/**
 * Record that the writer opened a document. Resolves `true` when the server
 * moved the stored recency, `false` when this open was inside the interval the
 * server already has, or when it failed. Callers use the result to refresh the
 * list; the open never waits on this.
 *
 * Whether two opens are the same open is the server's rule, so the interval
 * lives with the row it governs and every device shares one clock.
 */
export async function recordRecentDocument(documentId: string): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await postJson<RecordRecentDocumentResponse>(
        apiAccountRecentDocumentsPath(),
        { documentId },
      );
      return response.recorded;
    } catch (error) {
      const delay = RECORD_RETRY_MS[attempt];
      // Only a row that is not visible yet is worth retrying; anything else,
      // including a document the writer cannot reach, is a real fault.
      if (!(error instanceof HttpResponseError) || error.status !== 404 || delay === undefined) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
