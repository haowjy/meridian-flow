import {
  apiAccountRecentDocumentsPath,
  apiProjectRecentDocumentsPath,
  type ListRecentDocumentsResponse,
  type RecentDocumentItem,
  type RecordRecentDocumentResponse,
} from "@meridian/contracts/protocol";

import { getJson, postJson } from "./http-client";

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

export type RecordRecentDocumentResult = { kind: "recorded" | "unchanged" | "failed" };

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
