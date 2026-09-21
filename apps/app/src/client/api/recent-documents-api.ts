/**
 * Account-global recently opened documents: list plus fire-and-forget record.
 */
import {
  apiAccountRecentDocumentsPath,
  type ListRecentDocumentsResponse,
  type RecentDocumentItem,
} from "@meridian/contracts/protocol";

import { getJson, postJson } from "./http-client";

const RECORD_THROTTLE_MS = 5_000;
// A freshly created document's row lags its open, so the first write can miss.
const RECORD_RETRY_MS = [1_500, 3_000, 6_000];
const lastRecordedAt = new Map<string, number>();

export async function listRecentDocuments(opts?: {
  limit?: number;
}): Promise<RecentDocumentItem[]> {
  const response = await getJson<ListRecentDocumentsResponse>(apiAccountRecentDocumentsPath(opts));
  return response.documents;
}

/**
 * Fire-and-forget open recorder. Leading-edge throttle per account+document
 * (~5s). Retries a miss so a document whose row has not materialized yet (a
 * fresh create) still lands once the server knows it.
 */
export function recordRecentDocument(documentId: string, accountId?: string): void {
  const key = accountId ? `${accountId}:${documentId}` : documentId;
  const now = Date.now();
  const last = lastRecordedAt.get(key) ?? 0;
  if (now - last < RECORD_THROTTLE_MS) return;
  lastRecordedAt.set(key, now);
  const attempt = (index: number) => {
    void postJson(apiAccountRecentDocumentsPath(), { documentId }).catch(() => {
      const delay = RECORD_RETRY_MS[index];
      if (delay === undefined) return;
      window.setTimeout(() => attempt(index + 1), delay);
    });
  };
  attempt(0);
}
