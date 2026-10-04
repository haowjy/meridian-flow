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

import { getJson, postJson } from "./http-client";

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
 * Record that the writer opened a document. The open never waits on this, and
 * the caller posts only once the server holds the document
 * (`useRecordOpenedDocument`), so a 404 is a real fault, not a race.
 * Whether two opens are the same open is the server's write-interval rule, so
 * the interval lives with the row it governs and every device shares one clock.
 */
export async function recordRecentDocument(
  documentId: string,
  signal?: AbortSignal,
): Promise<RecordRecentDocumentResult> {
  if (signal?.aborted) return { kind: "failed" };
  try {
    const response = await postJson<RecordRecentDocumentResponse>(
      apiAccountRecentDocumentsPath(),
      { documentId },
      { signal },
    );
    return response.recorded ? { kind: "recorded" } : { kind: "unchanged" };
  } catch {
    return { kind: "failed" };
  }
}
