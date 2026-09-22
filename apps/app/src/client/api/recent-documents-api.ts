/**
 * Account-global recently opened documents: list plus fire-and-forget record.
 */
import {
  apiAccountRecentDocumentsPath,
  apiProjectRecentDocumentsPath,
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

/**
 * The writer's history inside one project. The read is project-scoped because
 * the landing renders inside a project; the write below is not, because what an
 * open records is that this writer touched this document.
 */
export async function listRecentDocuments(
  projectId: string,
  signal?: AbortSignal,
): Promise<RecentDocumentItem[]> {
  const response = await getJson<ListRecentDocumentsResponse>(
    apiProjectRecentDocumentsPath(projectId),
    {
      signal,
    },
  );
  return response.documents;
}

/**
 * `recorded` moved the stored row. `unchanged` means the server already had
 * this document inside its write interval and left the row where it was.
 * `failed` is a network or authority fault. Those are not the same outcome:
 * an unchanged row still exists, and a failure proves nothing.
 */
export type RecordRecentDocumentResult = { kind: "recorded" | "unchanged" | "failed" };

/**
 * Record that the writer opened a document. The open never waits on this.
 * Whether two opens are the same open is the server's write-interval rule, so
 * the interval lives with the row it governs and every device shares one clock.
 */
export async function recordRecentDocument(
  documentId: string,
  signal?: AbortSignal,
): Promise<RecordRecentDocumentResult> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) return { kind: "failed" };
    try {
      const response = await postJson<RecordRecentDocumentResponse>(
        apiAccountRecentDocumentsPath(),
        { documentId },
        { signal },
      );
      return response.recorded ? { kind: "recorded" } : { kind: "unchanged" };
    } catch (error) {
      if (signal?.aborted) return { kind: "failed" };
      const delay = RECORD_RETRY_MS[attempt];
      // Only a row that is not visible yet is worth retrying; anything else,
      // including a document the writer cannot reach, is a real fault.
      if (!(error instanceof HttpResponseError) || error.status !== 404 || delay === undefined) {
        return { kind: "failed" };
      }
      const retry = await waitForRetry(delay, signal);
      if (!retry) return { kind: "failed" };
    }
  }
}

function waitForRetry(delay: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), delay);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
}
