import type { DocumentProperties } from "@meridian/contracts";

import { getJson } from "./http-client";

export function fetchDocumentProperties(
  projectId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentProperties> {
  return getJson<DocumentProperties>(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/properties`,
    signal ? { signal } : undefined,
  );
}
